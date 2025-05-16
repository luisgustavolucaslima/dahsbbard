const moment = require('moment');
const axios = require('axios');
const PQueue = require('p-queue').default;

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'AIzaSyBpqMDBX4ic49y85K4-3dNJyxkZwD2rZ9c';
const apiQueue = new PQueue({ concurrency: 5 });
const MAX_API_CALLS_PER_DAY = 1000;
let apiCallCount = 0;

// Função para enviar mensagem com timeout de exclusão
const enviarMensagem = async (chatId, mensagem, bot, options = {}) => {
  try {
    const sentMessage = await bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown', ...options });
    setTimeout(async () => {
      try {
        await bot.deleteMessage(chatId, sentMessage.message_id);
      } catch (err) {
        console.error(`[ERROR] Erro ao deletar mensagem ${sentMessage.message_id}:`, err.message);
      }
    }, 30000);
    return sentMessage;
  } catch (err) {
    console.error(`[ERROR] Erro ao enviar mensagem para ${chatId}:`, err.message);
    return null;
  }
};

// Função para calcular distância e tempo com retry
async function calculateDistance(origins, destinations, bot, chatId, retries = 3) {
  if (apiCallCount >= MAX_API_CALLS_PER_DAY) {
    console.error('[ERROR] Cota diária da API atingida');
    await enviarMensagem(chatId, '⚠️ *Limite de chamadas à API atingido. Tente novamente mais tarde.*', bot);
    return destinations.map(() => ({ distance: 'N/A', duration: 'N/A' }));
  }
  apiCallCount++;
  console.log(`[DEBUG] Contagem de chamadas à API: ${apiCallCount}`);
  if (apiQueue.size > 0) {
    await enviarMensagem(chatId, '⏳ *Calculando rota... Aguarde um momento.*', bot);
  }

  return apiQueue.add(async () => {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await axios.get('https://maps.googleapis.com/maps/api/distancematrix/json', {
          params: {
            origins: origins.join('|'),
            destinations: destinations.join('|'),
            key: GOOGLE_API_KEY,
          },
          timeout: 10000,
        });
        if (response.data.status !== 'OK') {
          throw new Error(`Erro na API do Google: ${response.data.error_message || response.data.status}`);
        }
        return response.data.rows[0].elements.map(element => {
          if (element.status !== 'OK') {
            return { distance: 'N/A', duration: 'N/A' };
          }
          return {
            distance: element.distance.text,
            duration: element.duration.text,
          };
        });
      } catch (error) {
        console.warn(`[DEBUG] Tentativa ${attempt} da API de distância falhou: ${error.message}`);
        if (attempt === retries) {
          console.error('[ERROR] Máximo de tentativas atingido para a API de distância:', error);
          return destinations.map(() => ({ distance: 'N/A', duration: 'N/A' }));
        }
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  });
}

// Exibir menu inicial
const showInitialMenu = async (chatId, nomeUsuario, bot) => {
  const keyboard = {
    inline_keyboard: [
      [{ text: '🚚 Iniciar Rota', callback_data: 'iniciar_rota' }],
      [{ text: '🛑 Sair', callback_data: 'sair' }],
    ],
  };
  return enviarMensagem(
    chatId,
    `👋 *Bem-vindo ao setor Entrega, ${nomeUsuario || 'Usuário'}!* 😊\nEscolha uma opção:`,
    bot,
    { reply_markup: keyboard }
  );
};

module.exports = async function tratarEntrega(texto, msg, sessao, db, bot, chatId, sessoes) {
  if (!sessao) {
    console.error('[ERROR] Sessão não definida ao chamar entrega.js');
    return enviarMensagem(chatId, '⚠️ *Erro interno: sessão não encontrada. Tente novamente.*', bot);
  }

  const ehCallback = typeof texto === 'object' && texto.data;
  texto = ehCallback ? texto.data : (texto || msg.text || '').toLowerCase();
  if (!sessao.subetapa) sessao.subetapa = null;

  // Timeout check
  if (sessao.rota && Date.now() - sessao.lastUpdated > 15 * 60 * 1000) {
    delete sessao.rota;
    sessao.subetapa = null;
    sessao.pedidoIdConfirmacao = null;
    sessao.valorEsperado = null;
    sessao.lastUpdated = Date.now();
    await enviarMensagem(chatId, '🕒 *Sessão expirada. O fluxo foi reiniciado.*', bot);
    return showInitialMenu(chatId, sessao.nome, bot);
  }

  // Manipular callbacks
  if (ehCallback) {
    const query = texto;
    const data = query.data;

    try {
      if (data === 'iniciar_rota') {
        const [rotaAtiva] = await db.query(
          'SELECT * FROM entregas WHERE entregador_id = ? AND hora_fim IS NULL',
          [chatId]
        );

        if (rotaAtiva.length > 0) {
          await bot.answerCallbackQuery(query.id);
          return enviarMensagem(chatId, '⚠️ *Você já possui uma rota ativa. Finalize antes de iniciar outra.*', bot);
        }

        const [pedidos] = await db.query(
          'SELECT * FROM entregas WHERE entregador_id IS NULL AND DATE(data_pedido) = CURDATE()'
        );

        if (!pedidos.length) {
          await bot.answerCallbackQuery(query.id);
          return enviarMensagem(chatId, '📭 *Nenhum pedido disponível para entrega.*', bot);
        }

        const idsPedidos = pedidos.map(p => p.pedido_id);
        const horaInicio = moment().format('YYYY-MM-DD HH:mm:ss');
        await db.query(
          `UPDATE entregas SET entregador_id = ?, hora_inicio = ?, status = 'rua' WHERE pedido_id IN (${idsPedidos.map(() => '?').join(',')})`,
          [chatId, horaInicio, ...idsPedidos]
        );

        await db.query(
          `INSERT INTO entregador (entregador, quantidade_pedidos, hora_inicio, create_at) VALUES (?, ?, ?, ?)`,
          [chatId, idsPedidos.length, horaInicio, horaInicio]
        );

        sessao.rota = {
          inicio: new Date(),
          entregues: [],
          falhas: [],
          total: idsPedidos.length,
          pedidosIds: idsPedidos,
        };
        sessao.etapa = 'enviar_localizacao';
        sessao.lastUpdated = Date.now();
        sessoes.set(chatId, sessao);

        const keyboard = {
          keyboard: [[{ text: '📍 Enviar Localização', request_location: true }]],
          one_time_keyboard: true,
          resize_keyboard: true,
        };
        await bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, '📍 *Por favor, envie sua localização fixa para calcularmos sua rota!*', {
          reply_markup: keyboard,
        });
      }

      if (data.startsWith('recebido_')) {
        const pedidoId = parseInt(data.split('_')[1]);
        if (isNaN(pedidoId)) {
          await bot.answerCallbackQuery(query.id);
          return enviarMensagem(chatId, '❌ *ID de pedido inválido.*', bot);
        }

        if (!sessao.rota.pedidosIds.includes(pedidoId)) {
          await bot.answerCallbackQuery(query.id);
          return enviarMensagem(chatId, '❌ *Este pedido não está na sua rota atual.*', bot);
        }

        if (sessao.rota.entregues.includes(pedidoId)) {
          await bot.answerCallbackQuery(query.id);
          return enviarMensagem(chatId, '⚠️ *Este pedido já foi marcado como recebido.*', bot);
        }
        if (sessao.rota.falhas.includes(pedidoId)) {
          await bot.answerCallbackQuery(query.id);
          return enviarMensagem(chatId, '⚠️ *Este pedido já foi marcado como falha.*', bot);
        }

        const [venda] = await db.query(
          'SELECT forma_pagamento, valor_total FROM vendas WHERE id = ?',
          [pedidoId]
        );

        if (!venda.length) {
          await bot.answerCallbackQuery(query.id);
          return enviarMensagem(chatId, '⚠️ *Pedido não encontrado na tabela de vendas.*', bot);
        }

        const { forma_pagamento, valor_total } = venda[0];

        if (forma_pagamento === 'dinheiro' || forma_pagamento === 'pix e dinheiro') {
          if (!valor_total) {
            await bot.answerCallbackQuery(query.id);
            return enviarMensagem(chatId, '⚠️ *Valor a ser pago não definido. Contate o suporte.*', bot);
          }

          sessao.subetapa = 'confirmar_valor';
          sessao.pedidoIdConfirmacao = pedidoId;
          sessao.valorEsperado = parseFloat(valor_total);
          sessao.lastUpdated = Date.now();
          sessoes.set(chatId, sessao);

          await bot.answerCallbackQuery(query.id);
          return enviarMensagem(
            chatId,
            `💵 *Este pedido foi pago em "${forma_pagamento}". O valor a ser recebido é R$${valor_total.toFixed(2)}. Digite o valor que você recebeu para confirmar.*`,
            bot
          );
        }

        await db.query(
          'UPDATE entregas SET recebido = 1, data_entrega = ? WHERE pedido_id = ?',
          [moment().format('YYYY-MM-DD HH:mm:ss'), pedidoId]
        );

        await db.query(
          'UPDATE vendas SET recebido = 1 WHERE id = ?',
          [pedidoId]
        );

        await db.query(
          'UPDATE pedidos_diarios SET recebido = 1, status = "finalizado" WHERE id = ?',
          [pedidoId]
        );

        sessao.rota.entregues.push(pedidoId);
        sessao.lastUpdated = Date.now();
        sessoes.set(chatId, sessao);

        const restantes = sessao.rota.total - (sessao.rota.entregues.length + sessao.rota.falhas.length);
        await bot.answerCallbackQuery(query.id);

        if (restantes > 0) {
          await enviarMensagem(chatId, `✅ *Pedido ${pedidoId} marcado como recebido. Faltam ${restantes} pedidos.*`, bot);
          return showRouteMenu(chatId, sessao, bot, db);
        } else {
          const keyboard = {
            inline_keyboard: [[{ text: '🏁 Finalizar Rota', callback_data: 'finalizar_rota' }]],
          };
          return enviarMensagem(
            chatId,
            '✅ *Todos os pedidos foram processados! Finalize a rota.*',
            bot,
            { reply_markup: keyboard }
          );
        }
      }

      if (data.startsWith('falha_')) {
        const pedidoId = parseInt(data.split('_')[1]);
        if (isNaN(pedidoId)) {
          await bot.answerCallbackQuery(query.id);
          return enviarMensagem(chatId, '❌ *ID de pedido inválido.*', bot);
        }

        if (!sessao.rota.pedidosIds.includes(pedidoId)) {
          await bot.answerCallbackQuery(query.id);
          return enviarMensagem(chatId, '❌ *Este pedido não está na sua rota atual.*', bot);
        }

        if (sessao.rota.entregues.includes(pedidoId)) {
          await bot.answerCallbackQuery(query.id);
          return enviarMensagem(chatId, '⚠️ *Este pedido já foi marcado como recebido.*', bot);
        }
        if (sessao.rota.falhas.includes(pedidoId)) {
          await bot.answerCallbackQuery(query.id);
          return enviarMensagem(chatId, '⚠️ *Este pedido já foi marcado como falha.*', bot);
        }

        await db.query(
          'UPDATE entregas SET status = "falha", data_entrega = ? WHERE pedido_id = ?',
          [moment().format('YYYY-MM-DD HH:mm:ss'), pedidoId]
        );

        await db.query(
          'UPDATE vendas SET recebido = 1 WHERE id = ?',
          [pedidoId]
        );

        await db.query(
          'UPDATE pedidos_diarios SET status = "falha" WHERE id = ?',
          [pedidoId]
        );

        sessao.rota.falhas.push(pedidoId);
        sessao.rota.pedidosIds = sessao.rota.pedidosIds.filter(id => id !== pedidoId);
        sessao.lastUpdated = Date.now();
        sessoes.set(chatId, sessao);

        const restantes = sessao.rota.total - (sessao.rota.entregues.length + sessao.rota.falhas.length);
        await bot.answerCallbackQuery(query.id);

        if (restantes > 0) {
          await enviarMensagem(chatId, `❌ *Pedido ${pedidoId} marcado como falha. Faltam ${restantes} pedidos.*`, bot);
          return showRouteMenu(chatId, sessao, bot, db);
        } else {
          const keyboard = {
            inline_keyboard: [[{ text: '🏁 Finalizar Rota', callback_data: 'finalizar_rota' }]],
          };
          return enviarMensagem(
            chatId,
            '✅ *Todos os pedidos foram processados! Finalize a rota.*',
            bot,
            { reply_markup: keyboard }
          );
        }
      }

      if (data === 'finalizar_rota') {
        const totalProcessados = sessao.rota.entregues.length + sessao.rota.falhas.length;
        if (totalProcessados < sessao.rota.total) {
          await bot.answerCallbackQuery(query.id);
          return enviarMensagem(
            chatId,
            '⚠️ *Ainda há pedidos pendentes. Marque todos como "Recebido" ou "Falha" antes de finalizar.*',
            bot
          );
        }

        const horaFim = moment();
        const horaInicio = moment(sessao.rota.inicio);
        const duracaoMinutos = horaFim.diff(horaInicio, 'minutes');
        const tempoMedio = moment.duration(duracaoMinutos, 'minutes');
        const tempoMedioPedido = moment.duration(duracaoMinutos / sessao.rota.total, 'minutes');

        const pedidosRestantes = sessao.rota.entregues;
        if (pedidosRestantes.length > 0) {
          await db.query(
            `UPDATE entregas SET hora_fim = ?, status = 'finalizado' WHERE pedido_id IN (${pedidosRestantes.map(() => '?').join(',')})`,
            [horaFim.format('HH:mm:ss'), ...pedidosRestantes]
          );

          await db.query(
            `UPDATE vendas SET recebido = 1 WHERE id IN (${pedidosRestantes.map(() => '?').join(',')})`,
            [...pedidosRestantes]
          );

          await db.query(
            `UPDATE pedidos_diarios SET status = 'finalizado' WHERE id IN (${pedidosRestantes.map(() => '?').join(',')})`,
            [...pedidosRestantes]
          );
        }

        const distanciaTotal = sessao.rota.distanciaTotal || 0;
        const tempoTotalEstimado = sessao.rota.tempoTotalMinutos || 0;
        await db.query(
          `UPDATE entregador SET hora_fim = ?, tempo_medio = ?, tempo_medio_pedido = ?, km = ?, tempo_estimado = ? WHERE entregador = ? AND hora_fim IS NULL`,
          [
            horaFim.format('YYYY-MM-DD HH:mm:ss'),
            moment.utc(tempoMedio.asMilliseconds()).format('HH:mm:ss'),
            moment.utc(tempoMedioPedido.asMilliseconds()).format('HH:mm:ss'),
            distanciaTotal.toFixed(2),
            Math.ceil(tempoTotalEstimado),
            chatId,
          ]
        );

        let resposta = '🏁 *Rota Finalizada*\n\n';
        resposta += `Pedidos entregues: ${sessao.rota.entregues.length}\n`;
        resposta += `Pedidos com falha: ${sessao.rota.falhas.length}\n`;
        resposta += `Distância total: ${distanciaTotal.toFixed(2)} km\n`;
        resposta += `Tempo total real: ${duracaoMinutos} minutos\n`;
        resposta += `Tempo estimado: ${Math.ceil(tempoTotalEstimado)} minutos`;

        delete sessao.rota;
        sessao.subetapa = null;
        sessao.pedidoIdConfirmacao = null;
        sessao.valorEsperado = null;
        sessao.lastUpdated = Date.now();
        sessoes.set(chatId, sessao);

        await bot.answerCallbackQuery(query.id);
        await enviarMensagem(chatId, resposta, bot);
        return showInitialMenu(chatId, sessao.nome, bot);
      }

      if (data === 'sair') {
        delete sessao.rota;
        sessao.subetapa = null;
        sessao.pedidoIdConfirmacao = null;
        sessao.valorEsperado = null;
        sessao.setor = null;
        sessao.autenticado = false;
        sessao.lastUpdated = Date.now();
        sessoes.set(chatId, sessao);
        await bot.answerCallbackQuery(query.id);
        return enviarMensagem(
          chatId,
          '🛑 *Você saiu do setor Entrega.*\nPara começar, envie *oi* ou sua senha pessoal.',
          bot
        );
      }

      await bot.answerCallbackQuery(query.id);
      return enviarMensagem(chatId, '⚠️ *Ação inválida. Tente novamente.*', bot);
    } catch (err) {
      console.error(`[ERROR] Erro ao processar callback ${data}:`, err.message);
      await bot.answerCallbackQuery(query.id);
      return enviarMensagem(chatId, '⚠️ *Erro ao processar ação. Tente novamente.*', bot);
    }
  }

  // Manipular localização
  if (msg.location && sessao.rota && sessao.etapa === 'enviar_localizacao') {
    const { latitude, longitude } = msg.location;
    sessao.rota.localizacaoOrigem = { latitude, longitude };
    sessao.etapa = null;
    sessao.lastUpdated = Date.now();
    sessoes.set(chatId, sessao);

    const [pedidos] = await db.query(
      `SELECT e.*, v.forma_pagamento, v.valor_total, v.valor_dinheiro
       FROM entregas e
       LEFT JOIN vendas v ON e.pedido_id = v.id
       WHERE e.pedido_id IN (${sessao.rota.pedidosIds.map(() => '?').join(',')})`,
      sessao.rota.pedidosIds
    );

    if (!pedidos.length) {
      return enviarMensagem(chatId, '⚠️ *Nenhum pedido encontrado para esta rota.*', bot);
    }

    const destinos = [];
    const pedidosComCoordenadas = [];
    for (const pedido of pedidos) {
      const enderecoFormatado = `${pedido.endereco}, Cascavel, Paraná, Brasil`;
      try {
        const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
          params: {
            address: enderecoFormatado,
            key: GOOGLE_API_KEY,
          },
          timeout: 10000,
        });
        if (response.data.status === 'OK' && response.data.results[0]) {
          const { lat, lng } = response.data.results[0].geometry.location;
          destinos.push(`${lat},${lng}`);
          pedidosComCoordenadas.push({
            pedido,
            latitude: lat,
            longitude: lng,
            enderecoFormatado,
          });
        } else {
          console.warn(`[DEBUG] Endereço não encontrado para pedido ${pedido.pedido_id}: ${enderecoFormatado}`);
          pedidosComCoordenadas.push({
            pedido,
            latitude: null,
            longitude: null,
            enderecoFormatado,
          });
        }
      } catch (error) {
        console.error(`[ERROR] Erro ao obter coordenadas para pedido ${pedido.pedido_id}:`, error.message);
        pedidosComCoordenadas.push({
          pedido,
          latitude: null,
          longitude: null,
          enderecoFormatado,
        });
      }
    }

    const origem = [`${latitude},${longitude}`];
    const resultadosDistancia = await calculateDistance(origem, destinos, bot, chatId);

    const pedidosComDetalhes = pedidosComCoordenadas.map((item, index) => {
      const resultado = resultadosDistancia[index] || { distance: 'N/A', duration: 'N/A' };
      return {
        ...item,
        distance: resultado.distance,
        duration: resultado.duration,
      };
    });

    const unvisited = pedidosComDetalhes.filter(p => p.latitude && p.longitude);
    const optimizedRoute = [];
    let currentLocation = { latitude, longitude };

    while (unvisited.length > 0) {
      let nearest = null;
      let nearestDistance = Infinity;
      let nearestIndex = -1;

      for (let i = 0; i < unvisited.length; i++) {
        const loc = unvisited[i];
        const distanciaMetros = loc.distance === 'N/A' ? Infinity : parseFloat(loc.distance.replace(/,/g, '').replace(' km', '')) * 1000;
        if (distanciaMetros < nearestDistance) {
          nearest = loc;
          nearestDistance = distanciaMetros;
          nearestIndex = i;
        }
      }

      if (nearest) {
        optimizedRoute.push(nearest);
        currentLocation = { latitude: nearest.latitude, longitude: nearest.longitude };
        unvisited.splice(nearestIndex, 1);
      } else {
        break;
      }
    }

    const pedidosSemCoordenadas = pedidosComDetalhes.filter(p => !p.latitude || !p.longitude);
    optimizedRoute.push(...pedidosSemCoordenadas);

    let resposta = '🚚 *Rota Otimizada*\n\n';
    let distanciaTotal = 0;
    let tempoTotalMinutos = 0;

    optimizedRoute.forEach((item, index) => {
      const pedido = item.pedido;
      const distancia = item.distance === 'N/A' ? 'Indisponível' : item.distance;
      const tempo = item.duration === 'N/A' ? 'Indisponível' : item.duration;
      if (item.distance !== 'N/A') {
        distanciaTotal += parseFloat(item.distance.replace(/,/g, '').replace(' km', '')) || 0;
      }
      if (item.duration !== 'N/A') {
        const tempoMinutos = parseFloat(item.duration.replace(' min', '')) || 0;
        tempoTotalMinutos += tempoMinutos;
      }
      const enderecoCodificado = encodeURIComponent(item.enderecoFormatado);
      const linkGoogleMaps = `https://www.google.com/maps/search/?api=1&query=${enderecoCodificado}`;
      resposta += `*${index + 1}. Pedido ${pedido.pedido_id}*\n`;
      resposta += `Cliente: ${pedido.cliente_numero}\n`;
      resposta += `Endereço: [${pedido.endereco}](${linkGoogleMaps})\n`;
      resposta += `Distância: ${distancia}\n`;
      resposta += `Tempo estimado: ${tempo}\n`;
      if (pedido.forma_pagamento) {
        resposta += `Forma de Pagamento: ${pedido.forma_pagamento}`;
        if (pedido.forma_pagamento === 'dinheiro' || pedido.forma_pagamento === 'pix e dinheiro') {
          const valorPago = pedido.valor_total ? parseFloat(pedido.valor_total).toFixed(2) : 'N/A';
          resposta += ` - Valor: R$${valorPago}`;
          if (pedido.forma_pagamento === 'pix e dinheiro' && pedido.valor_dinheiro) {
            resposta += ` (Dinheiro: R$${parseFloat(pedido.valor_dinheiro).toFixed(2)})`;
          }
        }
        resposta += '\n';
      }
      resposta += '\n';
    });

    resposta += `*Total*\n`;
    resposta += `Distância total: ${distanciaTotal.toFixed(2)} km\n`;
    resposta += `Tempo total estimado: ${Math.ceil(tempoTotalMinutos)} minutos`;

    sessao.rota.distanciaTotal = distanciaTotal;
    sessao.rota.tempoTotalMinutos = tempoTotalMinutos;
    sessao.optimizedRoute = optimizedRoute;
    sessao.lastUpdated = Date.now();
    sessoes.set(chatId, sessao);

    await enviarMensagem(chatId, resposta, bot);
    return showRouteMenu(chatId, sessao, bot, db);
  }

  // Confirmação de valor
  if (sessao.subetapa === 'confirmar_valor' && sessao.rota) {
    const pedidoId = sessao.pedidoIdConfirmacao;
    const valorEsperado = sessao.valorEsperado;

    const valorInformado = parseFloat(texto);
    if (isNaN(valorInformado)) {
      return enviarMensagem(chatId, '❌ *Por favor, informe um valor numérico válido. Exemplo: 50.00*', bot);
    }

    if (valorInformado !== valorEsperado) {
      return enviarMensagem(
        chatId,
        `❌ *O valor informado (${valorInformado.toFixed(2)}) não corresponde ao valor esperado (${valorEsperado.toFixed(2)}). Tente novamente.*`,
        bot
      );
    }

    await db.query(
      'UPDATE entregas SET recebido = 1, data_entrega = ? WHERE pedido_id = ?',
      [moment().format('YYYY-MM-DD HH:mm:ss'), pedidoId]
    );

    await db.query(
      'UPDATE vendas SET recebido = 1 WHERE id = ?',
      [pedidoId]
    );

    await db.query(
      'UPDATE pedidos_diarios SET recebido = 1, status = "finalizado" WHERE id = ?',
      [pedidoId]
    );

    sessao.rota.entregues.push(pedidoId);
    sessao.subetapa = null;
    sessao.pedidoIdConfirmacao = null;
    sessao.valorEsperado = null;
    sessao.lastUpdated = Date.now();
    sessoes.set(chatId, sessao);

    const restantes = sessao.rota.total - (sessao.rota.entregues.length + sessao.rota.falhas.length);
    if (restantes > 0) {
      await enviarMensagem(chatId, `✅ *Pedido ${pedidoId} marcado como recebido. Faltam ${restantes} pedidos.*`, bot);
      return showRouteMenu(chatId, sessao, bot, db);
    } else {
      const keyboard = {
        inline_keyboard: [[{ text: '🏁 Finalizar Rota', callback_data: 'finalizar_rota' }]],
      };
      return enviarMensagem(
        chatId,
        '✅ *Todos os pedidos foram processados! Finalize a rota.*',
        bot,
        { reply_markup: keyboard }
      );
    }
  }

  // Exibir menu inicial por padrão
  return showInitialMenu(chatId, sessao.nome, bot);
};

// Exibir menu da rota com botões para cada pedido
const showRouteMenu = async (chatId, sessao, bot, db) => {
  if (!sessao.rota || !sessao.optimizedRoute) {
    return enviarMensagem(chatId, '⚠️ *Nenhuma rota ativa. Inicie uma nova rota.*', bot);
  }

  const optimizedRoute = sessao.optimizedRoute;
  let resposta = '🚚 *Gerenciar Rota*\n\n';
  const keyboard = { inline_keyboard: [] };

  optimizedRoute.forEach((item, index) => {
    const pedido = item.pedido;
    if (!sessao.rota.entregues.includes(pedido.pedido_id) && !sessao.rota.falhas.includes(pedido.pedido_id)) {
      resposta += `*${index + 1}. Pedido ${pedido.pedido_id}*\n`;
      resposta += `Endereço: ${pedido.endereco}\n\n`;
      keyboard.inline_keyboard.push([
        { text: `✅ Recebido ${pedido.pedido_id}`, callback_data: `recebido_${pedido.pedido_id}` },
        { text: `❌ Falha ${pedido.pedido_id}`, callback_data: `falha_${pedido.pedido_id}` },
      ]);
    }
  });

  const restantes = sessao.rota.total - (sessao.rota.entregues.length + sessao.rota.falhas.length);
  resposta += `*Pedidos restantes:* ${restantes}\n`;
  resposta += `*Entregues:* ${sessao.rota.entregues.length}\n`;
  resposta += `*Falhas:* ${sessao.rota.falhas.length}`;

  if (restantes === 0) {
    keyboard.inline_keyboard.push([{ text: '🏁 Finalizar Rota', callback_data: 'finalizar_rota' }]);
  }
  keyboard.inline_keyboard.push([{ text: '🛑 Sair', callback_data: 'sair' }]);

  return enviarMensagem(chatId, resposta, bot, { reply_markup: keyboard });
};