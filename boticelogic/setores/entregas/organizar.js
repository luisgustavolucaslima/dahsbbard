const axios = require('axios');
require('dotenv').config();

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'YOUR_GOOGLE_API_KEY';
const MAX_MESSAGE_LENGTH = 4000;
const CIDADE_REFERENCIA = 'Cascavel, Paraná';

// Função para sleep
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Função para gerar o submenu de organizar rota
function getSubmenuOrganizarRota() {
  return {
    inline_keyboard: [
      [{ text: '📍 Iniciar Rota', callback_data: 'iniciar_rota' }],
      [{ text: '🛑 Finalizar Rota', callback_data: 'finalizar_rota' }],
      [{ text: '⬅️ Voltar', callback_data: 'voltar_menu' }, { text: '🛑 Sair', callback_data: 'sair' }]
    ]
  };
}

// Função para geocodificar endereço e obter latitude/longitude
async function geocodeAddress(address) {
  await sleep(600); // Atraso de 600ms antes da chamada
  try {
    const fullAddress = `${address}, ${CIDADE_REFERENCIA}`;
    const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: {
        address: fullAddress,
        key: GOOGLE_API_KEY,
      },
      timeout: 10000,
    });
    if (response.data.status === 'OK') {
      const { lat, lng } = response.data.results[0].geometry.location;
      return { lat, lng };
    }
    return null;
  } catch (error) {
    console.error(`[ERROR] Erro na geocodificação do endereço ${address}: ${error.message}`);
    return null;
  }
}

// Calcular distância usando endereços
async function calculateDistance(originAddress, destinationAddress, chatId, enviarMensagem) {
  await sleep(600); // Atraso de 600ms antes da chamada
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const origin = `${originAddress}, ${CIDADE_REFERENCIA}`;
      const destination = `${destinationAddress}, ${CIDADE_REFERENCIA}`;
      const response = await axios.get('https://maps.googleapis.com/maps/api/distancematrix/json', {
        params: {
          origins: origin,
          destinations: destination,
          key: GOOGLE_API_KEY,
        },
        timeout: 10000,
      });
      if (response.data.status !== 'OK' || response.data.rows[0].elements[0].status !== 'OK') {
        throw new Error(`Erro na API do Google: ${response.data.status} - ${response.data.rows[0].elements[0].status}`);
      }
      return response.data.rows[0].elements[0].distance.text;
    } catch (error) {
      console.error(`[DEBUG] Tentativa ${attempt} da API de distância falhou: ${error.message}`);
      if (attempt === 3) {
        await enviarMensagem(chatId, '⚠️ Erro ao calcular distância. Tente novamente mais tarde.', {
          reply_markup: {
            inline_keyboard: [[{ text: '⬅️ Voltar', callback_data: 'voltar_menu' }, { text: '🛑 Sair', callback_data: 'sair' }]]
          }
        });
        return 'N/A';
      }
      await sleep(1000 * attempt);
    }
  }
}

// Nova tabela para rotas salvas
async function criarTabelaRotasSalvas(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS rotas_salvas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      entregador_id INT NOT NULL,
      ponto_inicial VARCHAR(255),
      rota_json JSON,
      ultima_atualizacao DATETIME,
      hora_fim DATETIME,
      FOREIGN KEY (entregador_id) REFERENCES usuarios(id)
    )
  `);
}

async function salvarRota(db, entregadorId, pontoInicial, rotaOtimizada) {
  const rotaJson = JSON.stringify(rotaOtimizada);
  await db.query(
    'INSERT INTO rotas_salvas (entregador_id, ponto_inicial, rota_json, ultima_atualizacao, hora_fim) VALUES (?, ?, ?, NOW(), NULL) ON DUPLICATE KEY UPDATE ponto_inicial = ?, rota_json = ?, ultima_atualizacao = NOW(), hora_fim = NULL',
    [entregadorId, pontoInicial.address, rotaJson, pontoInicial.address, rotaJson]
  );
}

async function obterRotaAtiva(db, entregadorId) {
  const [rows] = await db.query('SELECT rota_json FROM rotas_salvas WHERE entregador_id = ? AND hora_fim IS NULL ORDER BY ultima_atualizacao DESC LIMIT 1', [entregadorId]);
  return rows.length > 0 ? JSON.parse(rows[0].rota_json) : null;
}

async function finalizarRota(db, entregadorId) {
  await db.query('UPDATE rotas_salvas SET hora_fim = NOW() WHERE entregador_id = ? AND hora_fim IS NULL', [entregadorId]);
}

async function checkDeliveryStatus(db, usuarioId) {
  const [pedidosPendentes] = await db.query(`
    SELECT e.id
    FROM entregas e
    JOIN pedidos_diarios p ON e.pedido_id = p.id
    WHERE p.valido = 1 AND e.status = 'rua' AND e.entregador_id = ?
  `, [usuarioId]);
  const [rotaAtiva] = await db.query(`
    SELECT id FROM rotas_salvas WHERE entregador_id = ? AND hora_fim IS NULL LIMIT 1
  `, [usuarioId]);
  return {
    hasPendingDeliveries: pedidosPendentes.length > 0,
    hasActiveRoute: rotaAtiva.length > 0,
    pendingCount: pedidosPendentes.length
  };
}

async function tratarOrganizarRota(texto, msg, sessao, db, bot, chatId, sessoes, enviarMensagem) {
  chatId = chatId || (msg ? msg.chat.id.toString() : null);
  if (!chatId) return false;
  const sessaoAtual = sessoes.get(chatId);

  // Inicializar tabela de rotas se não existir
  await criarTabelaRotasSalvas(db);

  // Iniciar ou continuar rota
  if (texto === 'organizar_rota' || (msg && msg.data === 'iniciar_rota')) {
    const status = await checkDeliveryStatus(db, sessaoAtual.usuario_id);
    if (status.hasActiveRoute || status.hasPendingDeliveries) {
      await enviarMensagem(chatId, `⚠️ *Você já tem uma rota ativa com ${status.pendingCount} pedido(s) pendente(s).*`, {
        reply_markup: getSubmenuOrganizarRota(),
        parse_mode: 'Markdown'
      });
      sessaoAtual.etapa = 'submenu_organizar_rota';
      sessaoAtual.submenu = 'organizar_rota';
      sessaoAtual.rotaAtiva = true;
      sessoes.set(chatId, sessaoAtual);
      return true;
    }
    console.log(`[DEBUG] Iniciando rota para chatId=${chatId}, usuario_id=${sessaoAtual.usuario_id}`);
    sessaoAtual.rotaAtiva = true; // Definir rotaAtiva explicitamente
    sessaoAtual.rota = [];
    sessaoAtual.pontoInicial = null;
    sessaoAtual.pedidoId = null;
    sessaoAtual.etapa = 'aguardando_ponto_inicial'; // Permitir entrada do ponto inicial
    sessoes.set(chatId, sessaoAtual);

    // Buscar pedidos válidos atribuídos ao entregador
    try {
      const [pedidos] = await db.query(`
        SELECT e.id, e.cliente_numero, e.endereco e.numero_diario
        FROM entregas e
        JOIN pedidos_diarios p ON e.numero_diario = p.id
        WHERE p.valido = 1 AND e.status = 'rua' AND e.entregador_id = ?
      `, [sessaoAtual.usuario_id]);
      console.log(`[DEBUG] Pedidos encontrados: ${pedidos.length}`);

      if (pedidos.length === 0) {
        sessaoAtual.rotaAtiva = false;
        sessaoAtual.etapa = 'submenu_organizar_rota';
        sessaoAtual.submenu = 'organizar_rota';
        sessoes.set(chatId, sessaoAtual);
        await enviarMensagem(chatId, '📭 *Nenhum pedido com status "rua" atribuído a você.*', {
          reply_markup: getSubmenuOrganizarRota(),
          parse_mode: 'Markdown'
        });
        return true;
      }

      // Criar botões para os pedidos
      const buttons = pedidos.map((p, index) => [{ text: `Seq. ${index + 1} - *Pedido #${p.id}*`, callback_data: `selecionar_pedido_${p.id}` }]);
      buttons.push([{ text: '✅ Concluir Edição', callback_data: 'concluir_edicao' }]);
      buttons.push([{ text: '🚫 Cancelar', callback_data: 'cancelar_rota' }, { text: '🛑 Sair', callback_data: 'sair' }]);

      // Enviar mensagem com o menu de pedidos e solicitação do ponto inicial
      await enviarMensagem(chatId, `📍 *Digite o endereço do ponto inicial da rota em ${CIDADE_REFERENCIA} ou selecione um pedido para editar o endereço:*`, {
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });

      console.log(`[DEBUG] Menu de pedidos enviado para chatId=${chatId}, etapa=${sessaoAtual.etapa}`);
    } catch (err) {
      console.error(`[ERROR] Erro ao buscar pedidos: ${err.message}`);
      sessaoAtual.rotaAtiva = false;
      sessaoAtual.etapa = 'submenu_organizar_rota';
      sessaoAtual.submenu = 'organizar_rota';
      sessoes.set(chatId, sessaoAtual);
      await enviarMensagem(chatId, '⚠️ *Erro ao carregar pedidos. Verifique sua conexão e tente novamente.*', {
        reply_markup: getSubmenuOrganizarRota(),
        parse_mode: 'Markdown'
      });
      return true;
    }
    return true;
  }

  // Finalizar rota
  if (msg && msg.data === 'finalizar_rota') {
    if (msg.data) await bot.answerCallbackQuery(msg.id); // Adicionar resposta à callback
    await finalizarRota(db, sessaoAtual.usuario_id);
    sessaoAtual.rotaAtiva = false;
    sessaoAtual.etapa = 'submenu_organizar_rota';
    sessaoAtual.pontoInicial = null;
    sessaoAtual.rota = [];
    sessaoAtual.pedidoId = null;
    sessoes.set(chatId, sessaoAtual);
    await enviarMensagem(chatId, '🛑 *Rota finalizada com sucesso!*', {
      reply_markup: getSubmenuOrganizarRota()
    });
    return true;
  }

  // Cancelar organizar fluxo
  if ((msg && msg.data === 'cancelar_rota')) {
    if (msg.data) await bot.answerCallbackQuery(msg.id); // Adicionar resposta à callback
    try {
      await db.query('START TRANSACTION');
      // Finalizar rota ativa em rotas_salvas
      await db.query(`
        UPDATE rotas_salvas
        SET hora_fim = NOW()
        WHERE entregador_id = ? AND hora_fim IS NULL
      `, [sessaoAtual.usuario_id]);
      await db.query('COMMIT');
      sessaoAtual.etapa = 'submenu_organizar_rota';
      sessaoAtual.pontoInicial = null;
      sessaoAtual.rota = [];
      sessaoAtual.pedidoId = null;
      sessaoAtual.rotaAtiva = false; // Sincronizar com entrega.js
      sessoes.set(chatId, sessaoAtual);
      await enviarMensagem(chatId, '🚫 *Ação de organizar rota cancelada.*', {
        reply_markup: getSubmenuOrganizarRota()
      });
      return true;
    } catch (err) {
      await db.query('ROLLBACK');
      console.error(`[ERROR] Erro ao cancelar rota: ${err.message}`);
      await enviarMensagem(chatId, '⚠️ *Erro ao cancelar a rota. Tente novamente.*', {
        reply_markup: getSubmenuOrganizarRota()
      });
      return true;
    }
  }

  // Processar ponto inicial
  if (sessaoAtual.etapa === 'aguardando_ponto_inicial' && msg.text) {
    console.log(`[DEBUG] Mensagem recebida: chatId=${chatId}, etapa=${sessaoAtual.etapa}, texto=${msg.text}`);
    try {
      const pontoInicialAddress = msg.text.trim();
      if (pontoInicialAddress && pontoInicialAddress.length > 5) {
        // Validar ponto inicial com API
        const coords = await geocodeAddress(pontoInicialAddress);
        if (!coords) {
          await enviarMensagem(chatId, `⚠️ *Endereço inválido. Por favor, digite um endereço válido em ${CIDADE_REFERENCIA}.*`, {
            reply_markup: {
              inline_keyboard: [[{ text: '🚫 Cancelar', callback_data: 'cancelar_rota' }, { text: '🛑 Sair', callback_data: 'sair' }]]
            }
          });
          return true;
        }
        sessaoAtual.pontoInicial = { address: pontoInicialAddress };
        sessaoAtual.etapa = 'selecionar_pedido';
        sessaoAtual.rota = [];
        sessoes.set(chatId, sessaoAtual);
        console.log(`[DEBUG] Ponto inicial válido definido: ${pontoInicialAddress}`);

        // Buscar pedidos válidos atribuídos ao entregador
        const [pedidos] = await db.query(`
          SELECT e.id, e.cliente_numero, e.endereco
          FROM entregas e
          JOIN pedidos_diarios p ON e.pedido_id = p.id
          WHERE p.valido = 1 AND e.status = 'rua' AND e.entregador_id = ?
        `, [sessaoAtual.usuario_id]);
        console.log(`[DEBUG] Pedidos para edição de endereço: ${pedidos.length}`);

        if (pedidos.length === 0) {
          sessaoAtual.etapa = 'submenu_organizar_rota';
          sessaoAtual.submenu = 'organizar_rota';
          sessaoAtual.pontoInicial = null;
          sessaoAtual.pedidoId = null;
          sessaoAtual.rota = [];
          sessaoAtual.rotaAtiva = false;
          sessoes.set(chatId, sessaoAtual);
          await enviarMensagem(chatId, '📭 *Nenhum pedido com status "rua" atribuído a você.*', {
            reply_markup: getSubmenuOrganizarRota()
          });
          return true;
        }

        // Listar pedidos para seleção
        const buttons = pedidos.map((p, index) => [{ text: `Seq. ${index + 1} - *Pedido #${p.id}*`, callback_data: `selecionar_pedido_${p.id}` }]);
        buttons.push([{ text: '✅ Concluir Edição', callback_data: 'concluir_edicao' }]);
        buttons.push([{ text: '🚫 Cancelar', callback_data: 'cancelar_rota' }, { text: '🛑 Sair', callback_data: 'sair' }]);
        await enviarMensagem(chatId, '🔍 *Selecione um pedido para editar o endereço ou conclua a edição:*', {
          reply_markup: {
            inline_keyboard: buttons
          },
          parse_mode: 'Markdown'
        });
      } else {
        await enviarMensagem(chatId, `⚠️ *Por favor, digite um endereço válido (mínimo 5 caracteres) em ${CIDADE_REFERENCIA}.*`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🚫 Cancelar', callback_data: 'cancelar_rota' }, { text: '🛑 Sair', callback_data: 'sair' }]
            ]
          }
        });
      }
    } catch (err) {
      console.error(`[ERROR] Erro ao processar ponto inicial: ${err.message}`);
      await enviarMensagem(chatId, '⚠️ *Erro ao processar o ponto inicial.*', {
        reply_markup: {
          inline_keyboard: [[{ text: '🚫 Cancelar', callback_data: 'cancelar_rota' }, { text: '🛑 Sair', callback_data: 'sair' }]]
        }
      });
    }
    return true;
  }

  // Processar edição de endereço
  if (sessaoAtual.etapa === 'editar_endereco_texto' && msg.text) {
    console.log(`[DEBUG] Mensagem recebida: chatId=${chatId}, etapa=${sessaoAtual.etapa}, texto=${msg.text}`);
    try {
      const novoEndereco = msg.text.trim();
      const pedidoId = sessaoAtual.pedidoId;
      if (novoEndereco && novoEndereco.length > 5) {
        // Validar endereço com API
        const coords = await geocodeAddress(novoEndereco);
        if (!coords) {
          await db.query('UPDATE entregas SET endereco = NULL WHERE id = ?', [pedidoId]);
          console.log(`[DEBUG] Endereço inválido para pedido #${pedidoId}, definido como NULL`);
          await enviarMensagem(chatId, `⚠️ *Endereço inválido. O endereço do pedido #${pedidoId} foi definido como não especificado. Digite um endereço válido em ${CIDADE_REFERENCIA}.*`, {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 Tentar Novamente', callback_data: `editar_endereco_${pedidoId}` }],
                [{ text: '🚫 Cancelar', callback_data: 'cancelar_edicao' }, { text: '🛑 Sair', callback_data: 'sair' }]
              ]
            }
          });
          return true;
        }
        // Atualizar endereço no banco de dados
        await db.query('UPDATE entregas SET endereco = ? WHERE id = ?', [novoEndereco, pedidoId]);
        console.log(`[DEBUG] Endereço do pedido #${pedidoId} atualizado: ${novoEndereco}`);
        await enviarMensagem(chatId, `✅ *Endereço do pedido #${pedidoId} atualizado com sucesso!*\nNovo endereço: ${novoEndereco}`);
        // Listar pedidos novamente para edição
        const [pedidos] = await db.query(`
          SELECT e.id, e.cliente_numero, e.endereco
          FROM entregas e
          JOIN pedidos_diarios p ON e.pedido_id = p.id
          WHERE p.valido = 1 AND e.status = 'rua' AND e.entregador_id = ?
        `, [sessaoAtual.usuario_id]);

        if (pedidos.length === 0) {
          sessaoAtual.etapa = 'submenu_organizar_rota';
          sessaoAtual.submenu = 'organizar_rota';
          sessaoAtual.pontoInicial = null;
          sessaoAtual.pedidoId = null;
          sessaoAtual.rota = [];
          sessaoAtual.rotaAtiva = false;
          sessoes.set(chatId, sessaoAtual);
          await enviarMensagem(chatId, '📭 *Nenhum pedido com status "rua" atribuído a você.*', {
            reply_markup: getSubmenuOrganizarRota()
          });
          return true;
        }

        const buttons = pedidos.map((p, index) => [{ text: `Seq. ${index + 1} - *Pedido #${p.id}*`, callback_data: `selecionar_pedido_${p.id}` }]);
        buttons.push([{ text: '✅ Concluir Edição', callback_data: 'concluir_edicao' }]);
        buttons.push([{ text: '🚫 Cancelar', callback_data: 'cancelar_rota' }, { text: '🛑 Sair', callback_data: 'sair' }]);
        await enviarMensagem(chatId, '🔍 *Selecione outro pedido para editar o endereço ou conclua a edição:*', {
          reply_markup: { inline_keyboard: buttons },
          parse_mode: 'Markdown'
        });

        sessaoAtual.etapa = 'selecionar_pedido';
        sessaoAtual.pedidoId = null;
        sessoes.set(chatId, sessaoAtual);
      } else {
        await enviarMensagem(chatId, `⚠️ *Por favor, digite um endereço válido (mínimo 5 caracteres) em ${CIDADE_REFERENCIA}.*`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🚫 Cancelar', callback_data: 'cancelar_edicao' }, { text: '🛑 Sair', callback_data: 'sair' }]
            ]
          }
        });
      }
    } catch (error) {
      console.error(`[ERROR] Erro ao atualizar endereço: ${error.message}`);
      await enviarMensagem(chatId, '⚠️ *Erro ao atualizar o endereço.*', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚫 Cancelar', callback_data: 'cancelar_edicao' }, { text: '🛑 Sair', callback_data: 'sair' }]
          ]
        }
      });
    }
    return true;
  }

  return false;
}

// Função para tratar callbacks relacionados a organizar rota
async function tratarCallbackOrganizarRota(query, sessao, db, bot, chatId, sessoes, enviarMensagem) {
  const data = query.data;
  if (typeof enviarMensagem !== 'function') {
    console.error('[ERROR] enviarMensagem não é uma função válida');
    throw new Error('Função enviarMensagem inválida');
  }
  try {
    if (data.startsWith('selecionar_pedido_')) {
      await bot.answerCallbackQuery(query.id);
      const pedidoId = parseInt(data.split('_')[2]);
      sessao.pedidoId = pedidoId;
      sessao.etapa = 'escolher_acao_endereco';
      sessoes.set(chatId, sessao);
      const [[pedido]] = await db.query('SELECT endereco FROM entregas WHERE id = ?', [pedidoId]);
      const enderecoAtual = pedido?.endereco || 'Não especificado';
      await enviarMensagem(chatId, `📍 *Endereço atual do pedido #${pedidoId}:*\n${enderecoAtual}\n\nEscolha uma ação:`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'MANTER', callback_data: `manter_endereco_${pedidoId}` }],
            [{ text: 'EDITAR', callback_data: `editar_endereco_${pedidoId}` }],
            [{ text: '🚫 Cancelar', callback_data: 'cancelar_edicao' }, { text: '🛑 Sair', callback_data: 'sair' }]
          ]
        }
      });
      return true;
    }

    if (data.startsWith('manter_endereco_')) {
      await bot.answerCallbackQuery(query.id);
      const pedidoId = parseInt(data.split('_')[2]);
      console.log(`[DEBUG] Mantendo endereço do pedido #${pedidoId}`);

      // Listar pedidos novamente para edição
      const [pedidos] = await db.query(`
        SELECT e.id, e.cliente_numero, e.endereco
        FROM entregas e
        JOIN pedidos_diarios p ON e.pedido_id = p.id
        WHERE p.valido = 1 AND e.status = 'rua' AND e.entregador_id = ?
      `, [sessao.usuario_id]);

      if (pedidos.length === 0) {
        sessao.etapa = 'submenu_organizar_rota';
        sessao.submenu = 'organizar_rota';
        sessao.pontoInicial = null;
        sessao.pedidoId = null;
        sessao.rota = [];
        sessoes.set(chatId, sessao);
        await enviarMensagem(chatId, '📭 *Nenhum pedido com status "rua" atribuído a você.*', {
          reply_markup: getSubmenuOrganizarRota()
        });
        return true;
      }

      const buttons = pedidos.map((p, index) => [{ text: `Seq. ${index + 1} - *Pedido #${p.id}*`, callback_data: `selecionar_pedido_${p.id}` }]);
      buttons.push([{ text: '✅ Concluir Edição', callback_data: 'concluir_edicao' }]);
      buttons.push([{ text: '🚫 Cancelar', callback_data: 'cancelar_rota' }, { text: '🛑 Sair', callback_data: 'sair' }]);
      await enviarMensagem(chatId, `✅ *Endereço do pedido #${pedidoId} mantido como está.*\n\n🔍 *Selecione outro pedido para editar o endereço ou conclua a edição:*`, {
        reply_markup: {
          inline_keyboard: buttons
        },
        parse_mode: 'Markdown'
      });

      sessao.etapa = 'selecionar_pedido';
      sessao.pedidoId = null;
      sessoes.set(chatId, sessao);
      return true;
    }

    if (data.startsWith('editar_endereco_')) {
      await bot.answerCallbackQuery(query.id);
      const pedidoId = parseInt(data.split('_')[2]);
      sessao.pedidoId = pedidoId;
      sessao.etapa = 'editar_endereco_texto';
      sessoes.set(chatId, sessao);
      await enviarMensagem(chatId, `📝 *Digite o novo endereço para o pedido #${pedidoId} em ${CIDADE_REFERENCIA}:*`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚫 Cancelar', callback_data: 'cancelar_edicao' }, { text: '🛑 Sair', callback_data: 'sair' }]
          ]
        }
      });
      return true;
    }

    if (data === 'cancelar_edicao') {
      await bot.answerCallbackQuery(query.id);
      const [pedidos] = await db.query(`
        SELECT e.id, e.cliente_numero, e.endereco
        FROM entregas e
        JOIN pedidos_diarios p ON e.pedido_id = p.id
        WHERE p.valido = 1 AND e.status = 'rua' AND e.entregador_id = ?
      `, [sessao.usuario_id]);

      const buttons = pedidos.map((p, index) => [{ text: `Seq. ${index + 1} - *Pedido #${p.id}*`, callback_data: `selecionar_pedido_${p.id}` }]);
      buttons.push([{ text: '✅ Concluir Edição', callback_data: 'concluir_edicao' }]);
      buttons.push([{ text: '🚫 Cancelar', callback_data: 'cancelar_rota' }, { text: '🛑 Sair', callback_data: 'sair' }]);
      await enviarMensagem(chatId, '🔍 *Edição cancelada. Selecione outro pedido ou conclua a edição:*', {
        reply_markup: {
          inline_keyboard: buttons
        },
        parse_mode: 'Markdown'
      });

      sessao.etapa = 'selecionar_pedido';
      sessao.pedidoId = null;
      sessoes.set(chatId, sessao);
      return true;
    }

    if (data === 'voltar_edicao') {
      await bot.answerCallbackQuery(query.id);
      const [pedidos] = await db.query(`
        SELECT e.id, e.cliente_numero, e.endereco
        FROM entregas e
        JOIN pedidos_diarios p ON e.pedido_id = p.id
        WHERE p.valido = 1 AND e.status = 'rua' AND e.entregador_id = ?
      `, [sessao.usuario_id]);

      if (pedidos.length === 0) {
        sessao.etapa = 'submenu_organizar_rota';
        sessao.submenu = 'organizar_rota';
        sessao.pontoInicial = null;
        sessao.pedidoId = null;
        sessao.rota = [];
        sessoes.set(chatId, sessao);
        await enviarMensagem(chatId, '📭 *Nenhum pedido com status "rua" atribuído a você.*', {
          reply_markup: getSubmenuOrganizarRota()
        });
        return true;
      }

      const buttons = pedidos.map((p, index) => [{ text: `Seq. ${index + 1} - *Pedido #${p.id}*`, callback_data: `selecionar_pedido_${p.id}` }]);
      buttons.push([{ text: '✅ Concluir Edição', callback_data: 'concluir_edicao' }]);
      buttons.push([{ text: '🚫 Cancelar', callback_data: 'cancelar_rota' }, { text: '🛑 Sair', callback_data: 'sair' }]);
      await enviarMensagem(chatId, '🔍 *Selecione um pedido para editar o endereço ou conclua a edição:*', {
        reply_markup: {
          inline_keyboard: buttons
        },
        parse_mode: 'Markdown'
      });

      sessao.etapa = 'selecionar_pedido';
      sessao.pedidoId = null;
      sessoes.set(chatId, sessao);
      return true;
    }

    if (data === 'concluir_edicao') {
      await bot.answerCallbackQuery(query.id);
      sessao.etapa = 'coletando_pedidos';
      sessoes.set(chatId, sessao);

      // Buscar pedidos válidos atribuídos ao entregador
      const [pedidos] = await db.query(`
        SELECT e.id, e.cliente_numero, e.endereco
        FROM entregas e
        JOIN pedidos_diarios p ON e.pedido_id = p.id
        WHERE p.valido = 1 AND e.status = 'rua' AND e.entregador_id = ?
      `, [sessao.usuario_id]);
      console.log(`[DEBUG] Pedidos para geração da rota: ${pedidos.length}`);

      if (pedidos.length === 0) {
        sessao.rotaAtiva = false;
        sessao.etapa = 'submenu_organizar_rota';
        sessao.submenu = 'organizar_rota';
        sessoes.set(chatId, sessao);
        await enviarMensagem(chatId, '📭 *Nenhum pedido com status "rua" atribuído a você.*', {
          reply_markup: getSubmenuOrganizarRota()
        });
        return true;
      }

      // Preparar localizações dos pedidos (apenas endereços)
      sessao.rota = pedidos.map(p => ({
        pedidoId: p.id,
        address: p.endereco || 'Não especificado'
      }));

      // Filtrar apenas pedidos com endereços válidos
      const validLocations = sessao.rota.filter(loc => loc.address && loc.address !== 'Não especificado');
      if (validLocations.length === 0) {
        await enviarMensagem(chatId, '⚠️ *Nenhum pedido com endereço válido para gerar a rota.*', {
          reply_markup: getSubmenuOrganizarRota()
        });
        sessao.etapa = 'submenu_organizar_rota';
        sessao.submenu = 'organizar_rota';
        sessao.pontoInicial = null;
        sessao.pedidoId = null;
        sessao.rota = [];
        sessoes.set(chatId, sessao);
        return true;
      }

      // Algoritmo Nearest Neighbor para otimizar a rota
      const unvisited = [...validLocations];
      const optimizedRoute = [];
      let currentAddress = sessao.pontoInicial.address;

      while (unvisited.length > 0) {
        let nearest = null;
        let nearestDistance = Infinity;
        let nearestIndex = -1;

        for (let i = 0; i < unvisited.length; i++) {
          const loc = unvisited[i];
          const distance = await calculateDistance(currentAddress, loc.address, chatId, enviarMensagem);
          const distanceValue = distance === 'N/A' ? Infinity : parseFloat(distance.replace(/,/g, '').replace(' km', '')) || 0;
          if (distanceValue < nearestDistance) {
            nearest = loc;
            nearestDistance = distanceValue;
            nearestIndex = i;
          }
        }

        if (nearest) {
          optimizedRoute.push({ ...nearest, distance: nearestDistance === Infinity ? 'N/A' : nearestDistance + ' km' });
          currentAddress = nearest.address;
          unvisited.splice(nearestIndex, 1);
        } else {
          break;
        }
      }

      const invalidLocations = sessao.rota.filter(loc => !loc.address || loc.address === 'Não especificado');
      if (invalidLocations.length > 0) {
        const invalidList = invalidLocations.map(loc => `📦 Pedido #${loc.pedidoId}`).join('\n');
        await enviarMensagem(chatId, `⚠️ *Os seguintes pedidos não têm endereços válidos e foram excluídos da rota:*\n${invalidList}`, {
          reply_markup: { inline_keyboard: [[{ text: '🔄 Editar Pedidos', callback_data: 'voltar_edicao' }, { text: '🚫 Cancelar', callback_data: 'cancelar_rota' }]] },
          parse_mode: 'Markdown'
        });
        if (validLocations.length === 0) {
          sessao.etapa = 'selecionar_pedido';
          sessoes.set(chatId, sessao);
          return true;
        }
      }

      // Salvar rota otimizada
      await salvarRota(db, sessao.usuario_id, sessao.pontoInicial, optimizedRoute);

      // Gerar botões para a rota
      const buttons = optimizedRoute.map((loc, index) => {
        return [{ text: `Seq. ${index + 1} - *Pedido #${loc.pedidoId}*`, callback_data: `detalhes_pedido_${loc.pedidoId}` }];
      });
      buttons.push([{ text: '⬅️ Voltar', callback_data: 'voltar_menu' }, { text: '🛑 Sair', callback_data: 'sair' }]);

      // Enviar mensagem com botões
      let message = `📋 *Relatório de Rota Otimizada*\n\n*Ponto Inicial*: ${sessao.pontoInicial.address}\n`;
      await enviarMensagem(chatId, message, {
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });

      sessao.etapa = 'submenu_organizar_rota';
      sessao.submenu = 'organizar_rota';
      sessao.pontoInicial = null;
      sessao.pedidoId = null;
      sessao.rota = [];
      sessoes.set(chatId, sessao);
      console.log(`[DEBUG] Rota otimizada gerada para chatId=${chatId}`);
      return true;
    }

    if (data.startsWith('detalhes_pedido_')) {
  await bot.answerCallbackQuery(query.id);
  const pedidoId = parseInt(data.split('_')[2]);
  const [[entrega]] = await db.query(`
    SELECT e.id, e.cliente_numero, e.endereco, v.forma_pagamento, v.valor_total, v.valor_pago
    FROM entregas e
    JOIN pedidos_diarios p ON e.pedido_id = p.id
    JOIN vendas v ON p.venda_id = v.id
    WHERE e.id = ? AND e.entregador_id = ?
  `, [pedidoId, sessao.usuario_id]);

  if (!entrega) {
    await enviarMensagem(chatId, '❌ *Pedido não encontrado ou não atribuído a você.*', {
      reply_markup: getSubmenuOrganizarRota()
    });
    return true;
  }

  // Geocodificar o endereço para gerar o link do Google Maps
  const coords = await geocodeAddress(entrega.endereco);
  let mapsLink = '';
  if (coords) {
    mapsLink = `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;
  } else {
    mapsLink = `https://www.google.com/maps/search/${encodeURIComponent(entrega.endereco + ', ' + CIDADE_REFERENCIA)}`;
  }

  // Determinar o valor a ser exibido
  let valorExibir = '';
  if (entrega.forma_pagamento === 'dinheiro') {
    valorExibir = `💵 R$ ${parseFloat(entrega.valor_total).toFixed(2)}`;
  } else if (entrega.forma_pagamento === 'pix+dinheiro') {
    const valorRestante = entrega.valor_total - (entrega.valor_pago || 0);
    valorExibir = `💵 R$ ${parseFloat(valorRestante).toFixed(2)}`;
  }

  const mensagemDetalhes = [
    `📦 *Detalhes do Pedido #${pedidoId}*`,
    `📞 ${entrega.cliente_numero}`,
    `📍 ${entrega.endereco.replace(/\*/g, '').replace(/_/g, '')}`,
    ...(valorExibir ? [valorExibir] : [])
  ].join('\n');

  await enviarMensagem(chatId, mensagemDetalhes, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🗺️ Abrir Localização', url: mapsLink }],
        [{ text: '✅ Receber', callback_data: `receber_pedido_${pedidoId}` }, { text: '❌ Negar', callback_data: `negar_pedido_${pedidoId}` }],
        [{ text: '⬅️ Voltar', callback_data: 'voltar_menu' }, { text: '🛑 Sair', callback_data: 'sair' }]
      ]
    },
    parse_mode: 'Markdown'
  });
  return true;
}

    if (data.startsWith('receber_pedido_')) {
      await bot.answerCallbackQuery(query.id);
      const pedidoId = parseInt(data.split('_')[2]);
      const DATETIME = getBrasiliaDateTime();

      await db.query('UPDATE entregas SET status = ?, hora_fim = ?, recebido = 1 WHERE id = ?', ['finalizado', DATETIME, pedidoId]);

      await enviarMensagem(chatId, `✅ *Pedido #${pedidoId} marcado como entregue com sucesso às ${DATETIME.split(' ')[1]}!*`, {
        reply_markup: getSubmenuOrganizarRota(),
        parse_mode: 'Markdown'
      });

      sessao.etapa = 'submenu_organizar_rota';
      sessao.submenu = 'organizar_rota';
      sessao.pedidoId = null;
      sessoes.set(chatId, sessao);
      return true;
    }

    if (data.startsWith('negar_pedido_')) {
      await bot.answerCallbackQuery(query.id);
      const pedidoId = parseInt(data.split('_')[2]);
      sessao.etapa = 'justificativa_falha';
      sessao.pedidoId = pedidoId;
      sessoes.set(chatId, sessao);
      await enviarMensagem(chatId, `❗ *Selecione o motivo da falha para o pedido #${pedidoId}:*`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Cliente Ausente', callback_data: `justificativa_Cliente Ausente_${pedidoId}` }],
            [{ text: 'Endereço Incorreto', callback_data: `justificativa_Endereço Incorreto_${pedidoId}` }],
            [{ text: 'Recusado pelo Cliente', callback_data: `justificativa_Recusado pelo Cliente_${pedidoId}` }],
            [{ text: 'Outro', callback_data: `justificativa_Outro_${pedidoId}` }],
            [{ text: '🚫 Cancelar', callback_data: 'cancelar_justificativa' }, { text: '🛑 Sair', callback_data: 'sair' }]
          ]
        },
        parse_mode: 'Markdown'
      });
      return true;
    }

    if (data.startsWith('justificativa_')) {
      await bot.answerCallbackQuery(query.id);
      const [_, justificativa, pedidoId] = data.split('_');
      const DATETIME = getBrasiliaDateTime();
      await db.query('UPDATE entregas SET status = ?, hora_fim = ?, observacoes = ? WHERE id = ?', ['falha', DATETIME, justificativa, parseInt(pedidoId)]);
      await enviarMensagem(chatId, `❌ *Pedido #${pedidoId} marcado como falha às ${DATETIME.split(' ')[1]} com justificativa: ${justificativa}.*`, {
        reply_markup: getSubmenuOrganizarRota(),
        parse_mode: 'Markdown'
      });
      sessao.etapa = 'submenu_organizar_rota';
      sessao.submenu = 'organizar_rota';
      sessao.pedidoId = null;
      sessoes.set(chatId, sessao);
      return true;
    }

    if (data === 'cancelar_justificativa') {
      await bot.answerCallbackQuery(query.id);
      sessao.etapa = 'submenu_organizar_rota';
      sessao.pedidoId = null;
      sessoes.set(chatId, sessao);
      await enviarMensagem(chatId, '🚫 *Justificativa cancelada.*', { reply_markup: getSubmenuOrganizarRota() });
      return true;
    }

    return false;
  } catch (err) {
    console.error(`[ERROR] Erro ao montar a rota: ${err.message}`);
    await enviarMensagem(chatId, '⚠️ *Erro ao montar a rota otimizada.*', {
      reply_markup: {
        inline_keyboard: [[{ text: '🚫 Cancelar', callback_data: 'cancelar_rota' }, { text: '🛑 Sair', callback_data: 'sair' }]]
      }
    });
    sessao.etapa = 'aguardando_ponto_inicial';
    sessao.pedidoId = null;
    sessao.rota = [];
    sessoes.set(chatId, sessao);
    return true;
  }
}

const getBrasiliaDateTime = () => {
  const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const [date, time] = now.split(', ');
  const [day, month, year] = date.split('/');
  return `${year}-${month}-${day} ${time}`;
};

// Função configurarOrganizarRota agora está vazia, pois os listeners foram movidos para entrega.js
function configurarOrganizarRota(bot, db, sessoes) {
  // Listeners foram movidos para configurarEntrega em entrega.js
}

module.exports = { tratarOrganizarRota, configurarOrganizarRota, getSubmenuOrganizarRota, tratarCallbackOrganizarRota };