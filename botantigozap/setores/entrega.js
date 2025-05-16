const moment = require('moment');
const axios = require('axios');
const GOOGLE_API_KEY = 'AIzaSyBpqMDBX4ic49y85K4-3dNJyxkZwD2rZ9c'; // substitua com sua chave real

module.exports = async function tratarEntrega(texto, msg, sessao, db, client, numero, sessoes) {
  const comando = (texto || '').toLowerCase();
  if (!sessao.subetapa) sessao.subetapa = null;

  if (comando === 'iniciar rota') { 
    // Verifica se já existe rota ativa (entregador_id associado e hora_fim nula)
    const [rotaAtiva] = await db.query(
      "SELECT * FROM entregas WHERE entregador_id = ? AND hora_fim IS NULL",
      [numero]
    );

    if (rotaAtiva.length > 0) {
      return msg.reply('⚠️ Você já possui uma rota ativa. Finalize antes de iniciar outra.');
    }

    // Seleciona pedidos livres (sem entregador_id)
    const [pedidos] = await db.query(
      "SELECT * FROM entregas WHERE entregador_id IS NULL AND DATE(data_pedido) = CURDATE()"
    ).catch(err => {
      console.error('Erro ao buscar pedidos:', err);
      return msg.reply('❌ Erro ao buscar pedidos. Tente novamente.');
    });

    if (!pedidos.length) {
      return msg.reply('📭 Nenhum pedido disponível para entrega.');
    }

    // Define os IDs dos pedidos a serem assumidos
    const idsPedidos = pedidos.map(p => p.pedido_id);
    
    // Atribui os pedidos ao entregador e registra o início da rota na tabela entregas
    const horaInicio = moment().format('YYYY-MM-DD HH:mm:ss');
    await db.query(
      `UPDATE entregas SET entregador_id = ?, hora_inicio = ?, status = 'rua' WHERE pedido_id IN (${idsPedidos.map(() => '?').join(',')})`,
      [numero, horaInicio, ...idsPedidos]
    );

    // Insere um registro na tabela entregador
    await db.query(
      `INSERT INTO entregador (entregador, quantidade_pedidos, hora_inicio, create_at) VALUES (?, ?, ?, ?)`,
      [numero, idsPedidos.length, horaInicio, horaInicio]
    );

    // Salva na sessão
    sessao.rota = {
      inicio: new Date(),
      entregues: [],
      falhas: [], // Lista para pedidos com status "falha"
      total: idsPedidos.length,
      pedidosIds: idsPedidos
    };
    if (sessoes && typeof sessoes.set === 'function') {
      sessoes.set(numero, sessao);
    } else {
      console.error('Erro: sessoes não é um Map válido');
      return msg.reply('⚠️ Erro interno ao salvar sessão. Tente novamente.');
    }

    return msg.reply('📍 Envie sua localização fixa, para calcularmos sua rota!');
  }

  // Verifica se mensagem contém localização
  else if (msg.location && sessao.rota) {
    const { latitude, longitude } = msg.location;

    // Ponto de origem fixado pelo entregador
    const origem = `${latitude},${longitude}`;
    sessao.rota.localizacaoOrigem = origem;
    if (sessoes && typeof sessoes.set === 'function') {
      sessoes.set(numero, sessao);
    } else {
      console.error('Erro: sessoes não é um Map válido');
      return msg.reply('⚠️ Erro interno ao salvar sessão. Tente novamente.');
    }

    // Buscar os pedidos associados a essa rota
    const [pedidos] = await db.query(
      `SELECT * FROM entregas WHERE pedido_id IN (${sessao.rota.pedidosIds.map(() => '?').join(',')})`,
      sessao.rota.pedidosIds
    );

    if (!pedidos.length) {
      return msg.reply('⚠️ Nenhum pedido encontrado para esta rota.');
    }

    // Formata os endereços para a API do Google Maps (adiciona cidade e país para maior precisão)
    const destinos = pedidos.map(p => {
      const enderecoFormatado = `${p.endereco}, Cascavel, Paraná, Brasil`;
      return enderecoFormatado;
    });

    // Chamada à API do Google
    let distancias = [];
    try {
      const response = await axios.get('https://maps.googleapis.com/maps/api/distancematrix/json', {
        params: {
          origins: origem,
          destinations: destinos.join('|'),
          key: GOOGLE_API_KEY
        }
      });

      if (response.data.status !== 'OK') {
        throw new Error(`Erro na API do Google Maps: ${response.data.error_message || 'Status não OK'}`);
      }

      distancias = response.data.rows[0].elements.map((element, index) => {
        if (element.status !== 'OK') {
          console.error(`Erro ao calcular distância para o endereço ${destinos[index]}: ${element.status}`);
          return { pedido: pedidos[index], distancia: Infinity, tempo: Infinity };
        }
        const distanciaMetros = element.distance.value; // em metros
        const tempoSegundos = element.duration.value; // em segundos
        return { pedido: pedidos[index], distancia: distanciaMetros / 1000, tempo: tempoSegundos / 60 }; // distância em km, tempo em minutos
      });
    } catch (err) {
      console.error('Erro na chamada à API do Google Maps:', err.message);
      distancias = pedidos.map(pedido => ({ pedido, distancia: Infinity, tempo: Infinity }));
    }

    // Ordena os pedidos por distância (os com distância Infinity vão para o final)
    distancias.sort((a, b) => {
      if (a.distancia === Infinity && b.distancia === Infinity) return 0;
      if (a.distancia === Infinity) return 1;
      if (b.distancia === Infinity) return -1;
      return a.distancia - b.distancia;
    });

    // Monta a mensagem de resposta
    let resposta = '🚚 *Rota Calculada*\n\n';
    let distanciaTotal = 0;

    // Busca as formas de pagamento e valores pagos de todos os pedidos da rota de uma vez
    const pedidosIds = distancias.map(item => item.pedido.pedido_id);
    const [vendas] = await db.query(
      `SELECT id, forma_pagamento, valor_total FROM vendas WHERE id IN (${pedidosIds.map(() => '?').join(',')})`,
      pedidosIds
    );

    // Cria um mapa para acesso rápido às informações de vendas
    const vendasMap = {};
    vendas.forEach(venda => {
      vendasMap[venda.id] = venda;
    });

    // Monta a mensagem com as informações de pagamento
    distancias.forEach((item, index) => {
      const pedido = item.pedido;
      const distancia = item.distancia === Infinity ? 'Indisponível' : `${item.distancia.toFixed(2)} km`;
      if (item.distancia !== Infinity) {
        distanciaTotal += item.distancia;
      }
      const enderecoCodificado = encodeURIComponent(`${pedido.endereco}, Cascavel, Paraná, Brasil`);
      const linkGoogleMaps = `https://www.google.com/maps/search/?api=1&query=${enderecoCodificado}`;
      resposta += `*Pedido ${pedido.pedido_id}*\n`;
      resposta += `Cliente: ${pedido.cliente_numero}\n`;
      resposta += `Ver no mapa: [${pedido.endereco}](${linkGoogleMaps})\n`;
      resposta += `Distância: ${distancia}\n`;

      // Verifica a forma de pagamento e adiciona à mensagem, se aplicável
      const venda = vendasMap[pedido.pedido_id];
      if (venda && (venda.forma_pagamento === 'dinheiro' || venda.forma_pagamento === 'pix e dinheiro')) {
        const valorFormatado = venda.valor_total ? venda.valor_total.toFixed(2) : 'N/A';
        resposta += `Forma de Pagamento: ${venda.forma_pagamento} - Valor: R$ ${valorFormatado}\n`;
      }

      resposta += '\n';
    });

    // Salva a distância total na sessão para uso posterior
    sessao.rota.distanciaTotal = distanciaTotal;
    sessoes.set(numero, sessao);

    await msg.reply(resposta);
  }

  // Etapa de confirmação do valor recebido
  else if (sessao.subetapa === 'confirmar_valor' && sessao.rota) {
    const pedidoId = sessao.pedidoIdConfirmacao;
    const valorEsperado = sessao.valorEsperado;

    // Verifica se o valor informado pelo entregador corresponde ao valor_total
    const valorInformado = parseFloat(texto);
    if (isNaN(valorInformado)) {
      return msg.reply('❌ Por favor, informe um valor numérico válido. Exemplo: 50.00');
    }

    if (valorInformado !== valorEsperado) {
      return msg.reply(`❌ O valor informado (${valorInformado.toFixed(2)}) não corresponde ao valor esperado (${valorEsperado.toFixed(2)}). Tente novamente.`);
    }

    // Valor confirmado, marca o pedido como recebido
    await db.query(
      "UPDATE entregas SET recebido = 1, data_entrega = ? WHERE pedido_id = ?",
      [moment().format('YYYY-MM-DD HH:mm:ss'), pedidoId]
    );

    await db.query(
      "UPDATE vendas SET recebido = 1 WHERE pedido_id = ?",
      [pedidoId]
    );

    // Atualiza a tabela pedidos_diarios
    await db.query(
      "UPDATE pedidos_diarios SET recebido = 1, status = 'finalizado' WHERE id = ?",
      [pedidoId]
    );

    sessao.rota.entregues.push(pedidoId);
    sessao.subetapa = null; // Limpa a subetapa
    sessao.pedidoIdConfirmacao = null;
    sessao.valorEsperado = null;
    sessoes.set(numero, sessao);

    const restantes = sessao.rota.total - (sessao.rota.entregues.length + sessao.rota.falhas.length);
    if (restantes > 0) {
      return msg.reply(`✅ Pedido ${pedidoId} marcado como recebido. Faltam ${restantes} pedidos.`);
    } else {
      return msg.reply('✅ Todos os pedidos foram processados! Envie "finalizar rota" para encerrar.');
    }
  }

  // Comando "recebido [id]"
  else if (comando.startsWith('recebido ') && sessao.rota) {
    const pedidoId = parseInt(comando.split(' ')[1]);
    if (isNaN(pedidoId)) {
      return msg.reply('❌ Informe um ID de pedido válido. Exemplo: "recebido 1"');
    }

    // Verifica se o pedido está na rota atual
    if (!sessao.rota.pedidosIds.includes(pedidoId)) {
      return msg.reply('❌ Este pedido não está na sua rota atual.');
    }

    // Verifica se o pedido já foi marcado como recebido ou falha
    if (sessao.rota.entregues.includes(pedidoId)) {
      return msg.reply('⚠️ Este pedido já foi marcado como recebido.');
    }
    if (sessao.rota.falhas.includes(pedidoId)) {
      return msg.reply('⚠️ Este pedido já foi marcado como falha.');
    }

    // Consulta a forma de pagamento na tabela vendas
    const [venda] = await db.query(
      "SELECT forma_pagamento, valor_total FROM vendas WHERE id = ?",
      [pedidoId]
    );

    if (!venda.length) {
      return msg.reply('⚠️ Pedido não encontrado na tabela de vendas. Não é possível prosseguir.');
    }

    const { forma_pagamento, valor_total } = venda[0];

    // Se o pagamento for "dinheiro" ou "pix e dinheiro", solicita confirmação do valor
    if (forma_pagamento === 'dinheiro' || forma_pagamento === 'pix e dinheiro') {
      if (!valor_total) {
        return msg.reply('⚠️ O valor a ser pago não está definido para este pedido. Entre em contato com o suporte.');
      }

      sessao.subetapa = 'confirmar_valor';
      sessao.pedidoIdConfirmacao = pedidoId;
      sessao.valorEsperado = parseFloat(valor_total);
      sessoes.set(numero, sessao);

      return msg.reply(`💵 Este pedido foi pago em "${forma_pagamento}". O valor a ser recebido é R$ ${valor_total.toFixed(2)}. Digite o valor que você recebeu para confirmar.`);
    }

    // Se não for "dinheiro" nem "pix e dinheiro", marca diretamente como recebido
    await db.query(
      "UPDATE entregas SET recebido = 1, data_entrega = ? WHERE pedido_id = ?",
      [moment().format('YYYY-MM-DD HH:mm:ss'), pedidoId]
    );

    await db.query(
      "UPDATE vendas SET recebido = 1 WHERE id = ?",
      [pedidoId]
    );

    // Atualiza a tabela pedidos_diarios
    await db.query(
      "UPDATE pedidos_diarios SET recebido = 1, status = 'finalizado' WHERE id = ?",
      [pedidoId]
    );

    sessao.rota.entregues.push(pedidoId);
    sessoes.set(numero, sessao);

    const restantes = sessao.rota.total - (sessao.rota.entregues.length + sessao.rota.falhas.length);
    if (restantes > 0) {
      return msg.reply(`✅ Pedido ${pedidoId} marcado como recebido. Faltam ${restantes} pedidos.`);
    } else {
      return msg.reply('✅ Todos os pedidos foram processados! Envie "finalizar rota" para encerrar.');
    }
  }

  // Comando "falha [id]"
  else if (comando.startsWith('falha ') && sessao.rota) {
    const pedidoId = parseInt(comando.split(' ')[1]);
    if (isNaN(pedidoId)) {
      return msg.reply('❌ Informe um ID de pedido válido. Exemplo: "falha 1"');
    }

    // Verifica se o pedido está na rota atual
    if (!sessao.rota.pedidosIds.includes(pedidoId)) {
      return msg.reply('❌ Este pedido não está na sua rota atual.');
    }

    // Verifica se o pedido já foi marcado como recebido ou falha
    if (sessao.rota.entregues.includes(pedidoId)) {
      return msg.reply('⚠️ Este pedido já foi marcado como recebido.');
    }
    if (sessao.rota.falhas.includes(pedidoId)) {
      return msg.reply('⚠️ Este pedido já foi marcado como falha.');
    }

    // Marca o pedido como falha
    await db.query(
      "UPDATE entregas SET status = 'falha', data_entrega = ? WHERE pedido_id = ?",
      [moment().format('YYYY-MM-DD HH:mm:ss'), pedidoId]
    );

    await db.query(
      "UPDATE vendas SET recebido = 1 WHERE id = ?",
      [pedidoId]
    );

    // Atualiza a tabela pedidos_diarios
    await db.query(
      "UPDATE pedidos_diarios SET status = 'falha' WHERE id = ?",
      [pedidoId]
    );

    // Adiciona o pedido à lista de falhas
    sessao.rota.falhas.push(pedidoId);
    // Remove o pedido da lista de pedidos pendentes
    sessao.rota.pedidosIds = sessao.rota.pedidosIds.filter(id => id !== pedidoId);
    sessoes.set(numero, sessao);

    const restantes = sessao.rota.total - (sessao.rota.entregues.length + sessao.rota.falhas.length);
    if (restantes > 0) {
      return msg.reply(`❌ Pedido ${pedidoId} marcado como falha. Faltam ${restantes} pedidos.`);
    } else {
      return msg.reply('✅ Todos os pedidos foram processados! Envie "finalizar rota" para encerrar.');
    }
  }

  // Comando "finalizar rota"
  else if (comando === 'finalizar rota' && sessao.rota) {
    const totalProcessados = sessao.rota.entregues.length + sessao.rota.falhas.length;
    if (totalProcessados < sessao.rota.total) {
      return msg.reply('⚠️ Ainda há pedidos pendentes. Marque todos como "recebido" ou "falha" antes de finalizar.');
    }

    const horaFim = moment();
    const horaInicio = moment(sessao.rota.inicio);
    const duracaoMinutos = horaFim.diff(horaInicio, 'minutes');
    const tempoMedio = moment.duration(duracaoMinutos, 'minutes');
    const tempoMedioPedido = moment.duration(duracaoMinutos / sessao.rota.total, 'minutes');

    // Atualiza os pedidos na tabela entregas (apenas os não marcados como "falha")
    const pedidosRestantes = sessao.rota.entregues; // Pedidos que não foram marcados como "falha"
    if (pedidosRestantes.length > 0) {
      await db.query(
        `UPDATE entregas SET hora_fim = ?, status = 'finalizado' WHERE pedido_id IN (${pedidosRestantes.map(() => '?').join(',')})`,
        [horaFim.format('HH:mm:ss'), ...pedidosRestantes]
      );

      await db.query(
        `UPDATE vendas SET recebido = 1 WHERE id IN (${pedidosRestantes.map(() => '?').join(',')})`,
        [...pedidosRestantes]
      );

      // Atualiza a tabela pedidos_diarios
      await db.query(
        `UPDATE pedidos_diarios SET status = 'finalizado' WHERE id IN (${pedidosRestantes.map(() => '?').join(',')})`,
        [...pedidosRestantes]
      );
    }

    // Atualiza o registro na tabela entregador
    const distanciaTotal = sessao.rota.distanciaTotal || 0;
    await db.query(
      `UPDATE entregador SET hora_fim = ?, tempo_medio = ?, tempo_medio_pedido = ?, km = ? WHERE entregador = ? AND hora_fim IS NULL`,
      [
        horaFim.format('YYYY-MM-DD HH:mm:ss'),
        moment.utc(tempoMedio.asMilliseconds()).format('HH:mm:ss'),
        moment.utc(tempoMedioPedido.asMilliseconds()).format('HH:mm:ss'),
        distanciaTotal.toFixed(2),
        numero
      ]
    );

    // Limpa a sessão
    delete sessao.rota;
    sessao.subetapa = null;
    sessao.pedidoIdConfirmacao = null;
    sessao.valorEsperado = null;
    sessoes.set(numero, sessao);

    return msg.reply('🏁 Rota finalizada com sucesso!');
  }

  else {
    return msg.reply('ℹ️ Envie "iniciar rota" para começar, "recebido [id]" para marcar um pedido como entregue, "falha [id]" para marcar como não entregue, ou "finalizar rota" para encerrar.');
  }
};