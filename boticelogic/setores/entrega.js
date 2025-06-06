const { tratarOrganizarRota, configurarOrganizarRota, getSubmenuOrganizarRota, tratarCallbackOrganizarRota } = require('./entregas/organizar');

// Função para gerar o menu principal
function getMenuPrincipal() {
  return {
    inline_keyboard: [
      [{ text: '📦 Pedidos', callback_data: 'submenu_pedidos' }],
      [{ text: '🗺️ Organizar Rota', callback_data: 'submenu_organizar_rota' }],
      [{ text: '💰 Valores a Receber', callback_data: 'valores_receber' }],
      [{ text: 'ℹ️ Ajuda', callback_data: 'ajuda' }],
      [{ text: '🛑 Sair', callback_data: 'sair' }]
    ]
  };
}

// Função para gerar o submenu de pedidos
function getSubmenuPedidos() {
  return {
    inline_keyboard: [
      [{ text: '📋 Listar Pedidos', callback_data: 'lista' }],
      [{ text: '🔍 Ver Detalhes de Pedido', callback_data: 'pedidos' }],
      [{ text: '⬅️ Voltar', callback_data: 'voltar_menu' }, { text: '🛑 Sair', callback_data: 'sair' }]
    ]
  };
}

// Função auxiliar para listar pedidos pendentes
async function listarPedidosPendentes(chatId, sessao, db, enviarMensagem) {
  try {
    const [pedidos] = await db.query(`
      SELECT e.id, e.pedido_id, e.cliente_numero, e.status
      FROM entregas e
      JOIN pedidos_diarios p ON e.pedido_id = p.id
      WHERE p.valido = 1 AND e.status IN ('0', 'rua') AND e.entregador_id = ?
      ORDER BY e.id
    `, [sessao.usuario_id]);
    console.log(`[DEBUG] Pedidos encontrados: ${pedidos.length}`);
    if (pedidos.length === 0) {
      await enviarMensagem(chatId, '📭 *Nenhum pedido atribuído a você no momento.*', {
        reply_markup: getSubmenuPedidos()
      });
      return;
    }
    const lista = pedidos.map(p => `📦 Pedido #${p.id}\n📞 ${p.cliente_numero}`).join('\n\n');
    await enviarMensagem(chatId, `📋 *Lista de Pedidos Atribuídos:*\n\n${lista}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔍 Ver Detalhes de Pedido', callback_data: 'pedidos' }],
          [{ text: '⬅️ Voltar', callback_data: 'submenu_pedidos' }, { text: '🛑 Sair', callback_data: 'sair' }]
        ]
      }
    });
  } catch (err) {
    console.error(`[ERROR] Erro ao buscar pedidos: ${err.message}`);
    await enviarMensagem(chatId, '⚠️ *Erro ao buscar os pedidos.*', {
      reply_markup: getSubmenuPedidos()
    });
  }
}

async function tratarEntrega(texto, msg, sessao, db, bot, chatId, sessoes, enviarMensagem) {
  chatId = chatId || msg.chat.id.toString();

  // Corrige se texto for um objeto (query do botão)
  if (typeof texto === 'object' && texto.data) {
    msg = texto;
    texto = texto.data;
  } else if (msg?.data) {
    texto = msg.data;
  } else if (msg?.text) {
    texto = msg.text;
  }

  texto = (texto || '').toString().trim();
  console.log(`[DEBUG] tratarEntrega chamado: chatId=${chatId}, texto=${texto}`);

  // Inicializa a sessão se necessário
// Função auxiliar para verificar estado do entregador
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

// Inicializa a sessão se necessário
if (!sessoes.has(chatId)) {
  const initialState = {
    etapa: 'menu',
    locations: [],
    pontoInicial: null,
    pedidoId: null,
    submenu: null,
    rotaAtiva: false,
    entregadorRotaId: null
  };
  // Verificar estado do entregador
  const status = await checkDeliveryStatus(db, sessao.usuario_id);
  if (status.hasPendingDeliveries || status.hasActiveRoute) {
    initialState.rotaAtiva = true;
    initialState.etapa = 'submenu_organizar_rota';
    initialState.submenu = 'organizar_rota';
    sessoes.set(chatId, initialState);
    await enviarMensagem(chatId, `🚚 *Você tem uma rota ativa com ${status.pendingCount} pedido(s) pendente(s). Gerencie sua rota:`, {
      reply_markup: getSubmenuOrganizarRota()
    });
    await listarPedidosPendentes(chatId, { ...initialState, usuario_id: sessao.usuario_id }, db, enviarMensagem);
    return;
  }
  sessoes.set(chatId, initialState);
  await enviarMensagem(chatId, '🚚 *Bem-vindo ao painel do entregador!* Escolha uma opção:', {
    reply_markup: getMenuPrincipal()
  });
  return;
}

  const sessaoAtual = sessoes.get(chatId);
  console.log(`[DEBUG] Estado da sessão: ${JSON.stringify(sessaoAtual)}`);

  // Voltar ao menu principal
  if (texto === 'voltar_menu' || (msg && msg.data === 'voltar_menu')) {
    sessaoAtual.etapa = 'menu';
    sessaoAtual.submenu = null;
    sessaoAtual.pedidoId = null;
    sessaoAtual.pontoInicial = null;
    sessaoAtual.locations = [];
    sessaoAtual.justificativaSelecionada = null;
    sessoes.set(chatId, sessaoAtual);
    await enviarMensagem(chatId, '🚚 *Bem-vindo ao painel do entregador!* Escolha uma opção:', {
      reply_markup: getMenuPrincipal()
    });
    return;
  }

  // Sair do fluxo
  if (texto === 'sair' || (msg && msg.data === 'sair')) {
    sessoes.delete(chatId);
    await enviarMensagem(chatId, '🛑 *Você saiu do fluxo.* Para começar, envie *oi* ou sua senha pessoal.');
    return;
  }

  // Comando de ajuda
  if (texto === 'ajuda' || (msg && msg.data === 'ajuda')) {
    await enviarMensagem(chatId, 'ℹ️ *Ajuda:*\n- 📦 Pedidos: Gerencie pedidos (listar, detalhes, status).\n- 🗺️ Organizar Rota: Inicie/finalize rotas e planeje entregas.\n- 💰 Valores a Receber: Veja o total a receber em dinheiro ou pix+dinheiro.', {
      reply_markup: {
        inline_keyboard: [[{ text: '⬅️ Voltar', callback_data: 'voltar_menu' }, { text: '🛑 Sair', callback_data: 'sair' }]]
      }
    });
    return;
  }

  // Submenu Pedidos
if ((texto === 'submenu_pedidos' || (msg && msg.data === 'submenu_pedidos')) &&
    sessaoAtual.etapa !== 'submenu_pedidos') {
  sessaoAtual.etapa = 'submenu_pedidos';
  sessaoAtual.submenu = 'pedidos';
  sessoes.set(chatId, sessaoAtual);
  await enviarMensagem(chatId, '📦 *Menu de Pedidos:* Escolha uma opção:', {
    reply_markup: getSubmenuPedidos()
  });
  return;
}


  // Submenu Organizar Rota
  if (texto === 'submenu_organizar_rota' || (msg && msg.data === 'submenu_organizar_rota')) {
    sessaoAtual.etapa = 'submenu_organizar_rota';
    sessaoAtual.submenu = 'organizar_rota';
    sessoes.set(chatId, sessaoAtual);
    await enviarMensagem(chatId, '🗺️ *Menu de Rota:* Escolha uma opção:', {
      reply_markup: getSubmenuOrganizarRota()
    });
    return;
  }

  // Iniciar Rota
if (texto === 'iniciar_rota' || (msg && msg.data === 'iniciar_rota')) {
  console.log(`[DEBUG] Iniciando ou reabrindo rota para chatId=${chatId}, usuario_id=${sessaoAtual.usuario_id}`);
  try {
    await db.query('START TRANSACTION');

    // Verificar pedidos pendentes em entregas
    const [pedidosPendentes] = await db.query(`
      SELECT e.id, e.cliente_numero, e.endereco, e.latitude, e.longitude, p.venda_id
      FROM entregas e
      JOIN pedidos_diarios p ON e.pedido_id = p.id
      WHERE p.valido = 1 AND e.status = 'rua' AND e.entregador_id = ?
      ORDER BY e.id
    `, [sessaoAtual.usuario_id]);
    console.log(`[DEBUG] Pedidos pendentes encontrados: ${pedidosPendentes.length}`);

    // Verificar rotas abertas em entregador
    const [rotasAbertas] = await db.query(`
      SELECT id, quantidade_pedidos FROM entregador WHERE entregador = ? AND hora_fim IS NULL LIMIT 1
    `, [sessaoAtual.nome || 'Entregador Desconhecido']);
    console.log(`[DEBUG] Rotas abertas em entregador: ${rotasAbertas.length}`);

    if (pedidosPendentes.length > 0) {
      // Rota ativa com pedidos pendentes, reabrir
      sessaoAtual.rotaAtiva = true;
      sessaoAtual.etapa = 'aguardando_ponto_inicial';
      sessaoAtual.submenu = 'organizar_rota';
      sessaoAtual.entregadorRotaId = rotasAbertas.length > 0 ? rotasAbertas[0].id : null;
      sessaoAtual.pedidoId = null;
      sessaoAtual.pontoInicial = null;
      sessaoAtual.locations = pedidosPendentes.map(p => ({
        id: p.id,
        address: p.endereco || 'Endereço não especificado',
        latitude: p.latitude || null,
        longitude: p.longitude || null
      }));
      sessoes.set(chatId, sessaoAtual);

      // Listar pedidos pendentes
      const lista = pedidosPendentes.map(p => `📦 Entrega #${p.id}\n📞 ${p.cliente_numero}\n📍 ${p.endereco || 'Endereço não especificado'}`).join('\n\n');
      await enviarMensagem(chatId, `🚚 *Rota ativa com ${pedidosPendentes.length} pedido(s) pendente(s):*\n\n${lista}\n\n📍 *Envie sua localização para recalcular a rota.*`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚫 Cancelar', callback_data: 'cancelar_rota' }],
            [{ text: '🛑 Sair', callback_data: 'sair' }]
          ]
        }
      });

      await db.query('COMMIT');
      return;
    }

    // Não há pedidos pendentes, fechar rotas antigas e iniciar nova
    if (rotasAbertas.length > 0) {
      console.log(`[INFO] Fechando rotas antigas para entregador_id=${sessaoAtual.usuario_id}`);
      await db.query(`
        UPDATE entregador
        SET hora_fim = NOW(), tempo_medio = TIMEDIFF(NOW(), hora_inicio)
        WHERE id = ?
      `, [rotasAbertas[0].id]);
    }

    // Buscar pedidos atribuídos ao entregador com status 'rua'
    const [pedidos] = await db.query(`
      SELECT e.id, e.pedido_id
      FROM entregas e
      JOIN pedidos_diarios p ON e.pedido_id = p.id
      WHERE p.valido = 1 AND e.status = 'rua' AND e.entregador_id = ?
    `, [sessaoAtual.usuario_id]);
    console.log(`[INFO] Pedidos disponíveis para iniciar rota: ${pedidos.length}, IDs: ${pedidos.map(p => p.id).join(', ')}`);

    if (pedidos.length === 0) {
      await db.query('COMMIT');
      await enviarMensagem(chatId, '📭 *Nenhum pedido atribuído a você com status "rua" para iniciar uma rota.*', {
        reply_markup: getSubmenuOrganizarRota()
      });
      return;
    }

    // Obter nome do entregador
    const [[usuario]] = await db.query('SELECT nome FROM usuarios WHERE id = ?', [sessaoAtual.usuario_id]);
    const nomeEntregador = usuario?.nome || 'Entregador Desconhecido';

    // Criar registro na tabela entregador
    const [result] = await db.query(`
      INSERT INTO entregador (entregador, quantidade_pedidos, hora_inicio, create_at)
      VALUES (?, ?, NOW(), NOW())
    `, [nomeEntregador, pedidos.length]);
    const entregadorRotaId = result.insertId;
    console.log(`[INFO] Registro criado na tabela entregador: id=${entregadorRotaId}`);

    // Armazenar o ID do registro na sessão
    sessaoAtual.entregadorRotaId = entregadorRotaId;
    sessaoAtual.rotaAtiva = true;
    sessaoAtual.etapa = 'aguardando_ponto_inicial';
    sessaoAtual.submenu = 'organizar_rota';
    sessaoAtual.pedidoId = null;
    sessaoAtual.pontoInicial = null;
    sessaoAtual.locations = [];
    sessoes.set(chatId, sessaoAtual);

    // Atualizar as entregas com hora_inicio e data_saida
    await db.query(`
      UPDATE entregas e
      SET e.hora_inicio = CURRENT_TIME(), e.data_saida = NOW()
      WHERE e.entregador_id = ? AND e.status = 'rua'
    `, [sessaoAtual.usuario_id]);

    // Atualizar o status dos pedidos na tabela pedidos_diarios
    await db.query(`
      UPDATE pedidos_diarios p
      JOIN entregas e ON p.id = e.pedido_id
      SET p.status = 'rua'
      WHERE e.entregador_id = ? AND e.status = 'rua'
    `, [sessaoAtual.usuario_id]);

    await db.query('COMMIT');

    // Listar pedidos para nova rota
    const lista = pedidos.map(p => `📦 Entrega #${p.id}`).join('\n\n');
    await enviarMensagem(chatId, `🚚 *Rota iniciada com ${pedidos.length} pedido(s):*\n\n${lista}\n\n📍 *Envie sua localização para definir o ponto inicial da rota.*`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚫 Cancelar', callback_data: 'cancelar_rota' }],
          [{ text: '🛑 Sair', callback_data: 'sair' }]
        ]
      }
    });
    console.log(`[INFO] Solicitando localização para ponto inicial para chatId=${chatId}`);
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(`[ERROR] Erro ao iniciar/reabrir rota: ${err.message}`);
    sessaoAtual.rotaAtiva = false;
    sessaoAtual.entregadorRotaId = null;
    sessaoAtual.etapa = 'submenu_organizar_rota';
    sessaoAtual.submenu = 'organizar_rota';
    sessoes.set(chatId, sessaoAtual);
    await enviarMensagem(chatId, `⚠️ *Erro ao iniciar/reabrir a rota: ${err.message}. Tente novamente.*`, {
      reply_markup: getSubmenuOrganizarRota()
    });
  }
  return;
}

  // Finalizar Rota
  if (texto === 'finalizar_rota' || (msg && msg.data === 'finalizar_rota')) {
    if (!sessaoAtual.rotaAtiva) {
      await enviarMensagem(chatId, '⚠️ *Nenhuma rota ativa para finalizar.*', {
        reply_markup: getSubmenuOrganizarRota()
      });
      return;
    }

    try {
      await db.query('START TRANSACTION');

      // Verificar se há pedidos pendentes
      const [pedidosPendentes] = await db.query(`
        SELECT e.id, e.cliente_numero
        FROM entregas e
        JOIN pedidos_diarios p ON e.pedido_id = p.id
        WHERE p.valido = 1 AND e.status = 'rua' AND e.entregador_id = ?
      `, [sessaoAtual.usuario_id]);
      console.log(`[INFO] Pedidos pendentes ao finalizar rota: ${pedidosPendentes.length}`);

      if (pedidosPendentes.length > 0) {
        const listaPendentes = pedidosPendentes.map(p => `📦 Entrega #${p.id} - Cliente: ${p.cliente_numero}`).join('\n');
        await db.query('COMMIT');
        await enviarMensagem(chatId, `⚠️ *Existem pedidos pendentes que não foram entregues:*\n\n${listaPendentes}\n\nFinalize ou marque-os como falha antes de encerrar a rota.`, {
          reply_markup: getSubmenuOrganizarRota()
        });
        return;
      }

      // Atualizar entregas para status 'finalizado'
      await db.query(`
        UPDATE entregas
        SET hora_fim = CURRENT_TIME(), status = 'finalizado'
        WHERE entregador_id = ? AND status = 'rua'
      `, [sessaoAtual.usuario_id]);

      // Atualizar pedidos_diarios
      await db.query(`
        UPDATE pedidos_diarios p
        JOIN entregas e ON p.id = e.pedido_id
        SET p.status = 'finalizado'
        WHERE e.entregador_id = ? AND e.status = 'finalizado'
      `, [sessaoAtual.usuario_id]);

      // Atualizar registro na tabela entregador
      await db.query(`
        UPDATE entregador
        SET hora_fim = NOW(),
            tempo_medio = TIMEDIFF(NOW(), hora_inicio)
        WHERE id = ?
      `, [sessaoAtual.entregadorRotaId]);

      await db.query('COMMIT');

      sessaoAtual.rotaAtiva = false;
      sessaoAtual.entregadorRotaId = null;
      sessaoAtual.etapa = 'submenu_organizar_rota';
      sessaoAtual.submenu = 'organizar_rota';
      sessoes.set(chatId, sessaoAtual);

      await enviarMensagem(chatId, '✅ *Rota finalizada com sucesso! Todos os pedidos foram processados.*', {
        reply_markup: getSubmenuOrganizarRota()
      });
    } catch (err) {
      await db.query('ROLLBACK');
      console.error(`[ERROR] Erro ao finalizar rota: ${err.message}`);
      await enviarMensagem(chatId, '⚠️ *Erro ao finalizar a rota. Tente novamente.*', {
        reply_markup: getSubmenuOrganizarRota()
      });
    }
    return;
  }

  // 📋 Lista de pedidos válidos
  if (texto === 'lista' || (msg && msg.data === 'lista')) {
    await listarPedidosPendentes(chatId, sessao, db, enviarMensagem);
    sessaoAtual.etapa = null;
    sessaoAtual.submenu = 'pedidos';
    sessoes.set(chatId, sessaoAtual);
    return;
  }

  // 📦 Pedidos com botões interativos
  if (texto === 'pedidos' || (msg && msg.data === 'pedidos')) {
    try {
      const [pedidos] = await db.query(`
        SELECT e.id
        FROM entregas e
        JOIN pedidos_diarios p ON e.pedido_id = p.id
        WHERE p.valido = 1 AND e.status IN ('0', 'rua') AND e.entregador_id = ?
        ORDER BY e.id
      `, [sessao.usuario_id]);
      console.log(`[DEBUG] Pedidos para botões: ${pedidos.length}`);

      if (pedidos.length === 0) {
        await enviarMensagem(chatId, '📭 *Nenhum pedido atribuído a você.*', {
          reply_markup: {
            inline_keyboard: [[{ text: '⬅️ Voltar', callback_data: 'submenu_pedidos' }, { text: '🛑 Sair', callback_data: 'sair' }]]
          }
        });
        return;
      }

      const buttons = pedidos.map(p => [{ text: `Pedido #${p.id}`, callback_data: `pedido_${p.id}` }]);
      await enviarMensagem(chatId, '🔍 *Selecione um pedido para ver os detalhes:*', {
        reply_markup: {
          inline_keyboard: buttons.concat([[{ text: '⬅️ Voltar', callback_data: 'submenu_pedidos' }, { text: '🛑 Sair', callback_data: 'sair' }]])
        }
      });
      sessaoAtual.etapa = null;
      sessoes.set(chatId, sessaoAtual);
    } catch (err) {
      console.error(`[ERROR] Erro ao carregar pedidos: ${err.message}`);
      await enviarMensagem(chatId, '⚠️ *Erro ao carregar pedidos.*', {
        reply_markup: getSubmenuPedidos()
      });
    }
    return;
  }

  // 💰 Valores a Receber
  if (texto === 'valores_receber' || (msg && msg.data === 'valores_receber')) {
    try {
      const [vendas] = await db.query(`
        SELECT e.id, v.valor_total, v.forma_pagamento, v.valor_dinheiro
        FROM entregas e
        JOIN pedidos_diarios p ON e.pedido_id = p.id
        JOIN vendas v ON p.venda_id = v.id
        WHERE p.valido = 1 
          AND e.status IN ('0', 'rua')
          AND e.entregador_id = ?
          AND (v.forma_pagamento = 'dinheiro' OR v.forma_pagamento = 'pix+dinheiro')
      `, [sessao.usuario_id]);
      console.log(`[DEBUG] Vendas encontradas: ${vendas.length}`);

      if (vendas.length === 0) {
        await enviarMensagem(chatId, '📭 *Nenhuma venda pendente em dinheiro ou pix+dinheiro atribuída a você.*', {
          reply_markup: {
            inline_keyboard: [[{ text: '⬅️ Voltar', callback_data: 'voltar_menu' }, { text: '🛑 Sair', callback_data: 'sair' }]]
          }
        });
        return;
      }

      const lista = vendas.map(v => {
        const valor = v.forma_pagamento === 'pix+dinheiro' && v.valor_dinheiro ? v.valor_dinheiro : v.valor_total;
        return `📜 Entrega #${v.id}: R$ ${valor} (${v.forma_pagamento})`;
      }).join('\n');
      const total = vendas.reduce((sum, venda) => {
        const valor = venda.forma_pagamento === 'pix+dinheiro' && venda.valor_dinheiro ? venda.valor_dinheiro : venda.valor_total;
        return sum + (valor || 0);
      }, 0);
      await enviarMensagem(chatId, `💵 *Valores a Receber (Dinheiro/Pix+Dinheiro):*\n\n${lista}\n\n*Total*: R$ ${total}`, {
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ Voltar', callback_data: 'voltar_menu' }, { text: '🛑 Sair', callback_data: 'sair' }]]
        }
      });
    } catch (err) {
      console.error(`[ERROR] Erro ao calcular valores: ${err.message}`);
      await enviarMensagem(chatId, '⚠️ *Erro ao calcular valores a receber.*', {
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ Voltar', callback_data: 'voltar_menu' }, { text: '🛑 Sair', callback_data: 'sair' }]]
        }
      });
    }
    return;
  }

  // Captura justificativa de falha
  if (sessaoAtual.etapa === 'falha_justificativa') {
    if (msg && msg.data && msg.data.startsWith('justificativa_')) {
      const justificativa = msg.data.replace('justificativa_', '');
      const entregaId = sessaoAtual.pedidoId;
      try {
        await db.query('START TRANSACTION');

        await db.query('UPDATE entregas SET status = ?, observacoes = ? WHERE id = ?', ['falha', justificativa, entregaId]);
        await db.query('UPDATE pedidos_diarios SET status = "falha" WHERE id = (SELECT pedido_id FROM entregas WHERE id = ?)', [entregaId]);

        await db.query('COMMIT');

        console.log(`[DEBUG] Entrega #${entregaId} marcada com falha`);
        await enviarMensagem(chatId, `❌ *Entrega #${entregaId} marcada como falha com justificativa: ${justificativa}*`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔍 Ver Detalhes de Outro Pedido', callback_data: 'pedidos' }],
              [{ text: '⬅️ Voltar', callback_data: 'submenu_pedidos' }, { text: '🛑 Sair', callback_data: 'sair' }]
            ]
          }
        });
        await listarPedidosPendentes(chatId, sessao, db, enviarMensagem);

        // Verificar se a rota deve ser finalizada automaticamente
        await verificarFinalizarRotaAutomaticamente(chatId, sessao, db, enviarMensagem);

        sessaoAtual.etapa = null;
        sessaoAtual.submenu = 'pedidos';
        sessaoAtual.pedidoId = null;
        sessaoAtual.pontoInicial = null;
        sessaoAtual.locations = [];
        sessaoAtual.justificativaSelecionada = null;
        sessoes.set(chatId, sessaoAtual);
      } catch (err) {
        await db.query('ROLLBACK');
        console.error(`[ERROR] Erro ao salvar justificativa: ${err.message}`);
        await enviarMensagem(chatId, '⚠️ *Erro ao salvar justificativa.*', {
          reply_markup: {
            inline_keyboard: [[{ text: '🚫 Cancelar', callback_data: 'cancelar_justificativa' }, { text: '🛑 Sair', callback_data: 'sair' }]]
          }
        });
      }
      bot.answerCallbackQuery(msg.id, { cache_time: 1 });
      return;
    }
  }

  // Delegar para organizar rota
  const handledByOrganizarRota = await tratarOrganizarRota(texto, msg, sessao, db, bot, chatId, sessoes, enviarMensagem);
  if (handledByOrganizarRota) {
    console.log(`[DEBUG] Ação tratada por organizar_rota, pulando menu padrão para chatId=${chatId}`);
    return;
  }

  // Caso padrão: exibe o menu principal apenas se necessário
  if (sessaoAtual.etapa === 'detalhes_pedido' && sessaoAtual.pedidoId) {
    // Não faz nada, deixa o controle com configurarEntrega
    return;
  }
  if (sessaoAtual.etapa === 'submenu_pedidos' || sessaoAtual.submenu === 'pedidos') {
    await enviarMensagem(chatId, '📦 *Menu de Pedidos:* Escolha uma opção:', {
      reply_markup: getSubmenuPedidos()
    });
    return;
  }
  if (sessaoAtual.etapa === 'submenu_organizar_rota' || sessaoAtual.submenu === 'organizar_rota') {
    await enviarMensagem(chatId, '🗺️ *Menu de Rota:* Escolha uma opção:', {
      reply_markup: getSubmenuOrganizarRota()
    });
    return;
  }
  // Evita menu se já tratou etapas como detalhes
if (!sessaoAtual.etapa || sessaoAtual.etapa === 'menu') {
  await enviarMensagem(chatId, '🚚 *Bem-vindo ao painel do entregador!* Escolha uma opção:', {
    reply_markup: getMenuPrincipal()
  });
}
  sessaoAtual.etapa = 'menu';
  sessaoAtual.submenu = null;
  sessaoAtual.pedidoId = null;
  sessaoAtual.pontoInicial = null;
  sessaoAtual.locations = [];
  sessaoAtual.justificativaSelecionada = null;
  sessoes.set(chatId, sessaoAtual);
  console.log(`[DEBUG] Menu padrão exibido para chatId=${chatId}`);
  return;

}

async function verificarFinalizarRotaAutomaticamente(chatId, sessao, db, enviarMensagem) {
  try {
    const [pedidosPendentes] = await db.query(`
      SELECT e.id, e.cliente_numero
      FROM entregas e
      JOIN pedidos_diarios p ON e.pedido_id = p.id
      WHERE p.valido = 1 AND e.status = 'rua' AND e.entregador_id = ?
    `, [sessao.usuario_id]);

    if (pedidosPendentes.length === 0 && sessao.rotaAtiva) {
      console.log(`[DEBUG] Todos os pedidos finalizados, finalizando rota automaticamente para chatId=${chatId}`);
      await db.query('START TRANSACTION');

      // Atualizar registro na tabela entregador
      await db.query(`
        UPDATE entregador
        SET hora_fim = NOW(),
            tempo_medio = TIMEDIFF(NOW(), hora_inicio)
        WHERE id = ?
      `, [sessao.entregadorRotaId]);

      await db.query('COMMIT');

      sessao.rotaAtiva = false;
      sessao.entregadorRotaId = null;
      sessao.etapa = 'submenu_organizar_rota';
      sessao.submenu = 'organizar_rota';
      sessoes.set(chatId, sessao);

      await enviarMensagem(chatId, '✅ *Rota finalizada automaticamente! Todos os pedidos foram processados.*', {
        reply_markup: getSubmenuOrganizarRota()
      });
    } else if (pedidosPendentes.length > 0) {
      const listaPendentes = pedidosPendentes.map(p => `📦 Entrega #${p.id} - Cliente: ${p.cliente_numero}`).join('\n');
      await enviarMensagem(chatId, `⚠️ *Pedidos pendentes encontrados:*\n\n${listaPendentes}\n\nFinalize ou marque-os como falha para encerrar a rota.`, {
        reply_markup: getSubmenuOrganizarRota()
      });
    }
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(`[ERROR] Erro ao verificar finalização automática da rota: ${err.message}`);
    await enviarMensagem(chatId, '⚠️ *Erro ao verificar status da rota.*', {
      reply_markup: getSubmenuOrganizarRota()
    });
  }
}

function configurarEntrega(bot, db, sessoes) {
  // Configurar listener para callback queries
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id.toString();
    const data = query.data;
    console.log(`[DEBUG] Callback recebido: chatId=${chatId}, data=${data}`);

    const sessao = sessoes.get(chatId) || { etapa: 'menu', locations: [], pontoInicial: null, pedidoId: null, submenu: null, rotaAtiva: false };

    // Delegar para callbacks de organizar rota
    const enviarMensagemWrapper = async (chatId, message, options) => {
      if (!bot) {
        console.error('[ERROR] Instância do bot está undefined');
        throw new Error('Instância do bot não inicializada');
      }
      return bot.sendMessage(chatId, message, options);
    };

const handledByOrganizarRota = await tratarCallbackOrganizarRota(query, sessao, db, bot, chatId, sessoes, enviarMensagemWrapper);
    if (handledByOrganizarRota) {
      console.log(`[DEBUG] Callback tratado por organizar_rota: ${data}`);
      return;
    }

    if (data.startsWith('pedido_')) {
      await bot.answerCallbackQuery(query.id, { cache_time: 1 });
      const entregaId = parseInt(data.split('_')[1]);
      try {
        const [[entrega]] = await db.query(`
          SELECT e.id, e.cliente_numero, v.forma_pagamento, v.valor_total, e.status,
                GROUP_CONCAT(i.produto_id SEPARATOR ', ') AS itens, e.endereco
          FROM entregas e
          JOIN pedidos_diarios p ON e.pedido_id = p.id
          JOIN vendas v ON p.venda_id = v.id
          JOIN pedido_itens i ON p.id = i.pedido_id
          WHERE e.id = ? AND e.entregador_id = ?
          GROUP BY e.id, v.forma_pagamento, v.valor_total, e.status, e.endereco
        `, [entregaId, sessao.usuario_id]);
        console.log(`[DEBUG] Entrega #${entregaId} encontrada`);

        if (!entrega) {
          await bot.sendMessage(chatId, '❌ *Entrega não encontrada ou não atribuída a você.*', {
            reply_markup: {
              inline_keyboard: [[{ text: '⬅️ Voltar', callback_data: 'submenu_pedidos' }, { text: '🛑 Sair', callback_data: 'sair' }]]
            }
          });
          return;
        }

        let texto = `📦 *Entrega #${entrega.id}*
      📞 ${entrega.cliente_numero}
      🛒 Itens: Produto(s) #${entrega.itens}
      📍 Endereço: ${entrega.endereco || 'Não especificado'}
      💳 Pagamento: ${entrega.forma_pagamento}`;

        const botoes = [
          [{ text: '📲 Chamar no WhatsApp', url: `https://wa.me/55${entrega.cliente_numero}` }],
        ];

        if ((entrega.forma_pagamento === 'dinheiro' || entrega.forma_pagamento === 'pix+dinheiro') && entrega.status === 'rua') {
          botoes.push([
            { text: '✅ Recebido', callback_data: `recebido_${entrega.id}` },
            { text: '❌ Falha', callback_data: `falha_${entrega.id}` }
          ]);
        }

        botoes.push([
          { text: '⬅️ Voltar', callback_data: 'submenu_pedidos' },
          { text: '🛑 Sair', callback_data: 'sair' }
        ]);

        await bot.sendMessage(chatId, texto, {
          reply_markup: { inline_keyboard: botoes }
        });
        sessao.etapa = 'detalhes_pedido';
        sessao.pedidoId = entregaId; // Manter o ID do pedido atual
        sessao.submenu = 'pedidos'; // Manter o submenu como referência
        sessoes.set(chatId, sessao);
      } catch (err) {
        console.error(`[ERROR] Erro ao buscar detalhes da entrega: ${err.message}`);
        await bot.sendMessage(chatId, '⚠️ *Erro ao buscar detalhes da entrega.*', {
          reply_markup: getSubmenuPedidos()
        });
      }
      return;
    }

    if (data.startsWith('recebido_')) {
      await bot.answerCallbackQuery(query.id, { cache_time: 1 }); // Adiciona cache_time para evitar duplicação
      const entregaId = parseInt(data.split('_')[1]);
      try {
        await db.query('START TRANSACTION');

        await db.query('UPDATE entregas SET status = ?, data_entrega = NOW(), recebido = 1 WHERE id = ?', ['finalizado', entregaId]);
        await db.query('UPDATE pedidos_diarios SET status = "finalizado", recebido = 1 WHERE id = (SELECT pedido_id FROM entregas WHERE id = ?)', [entregaId]);
        await db.query('UPDATE vendas SET recebido = 1 WHERE id = (SELECT venda_id FROM pedidos_diarios WHERE id = (SELECT pedido_id FROM entregas WHERE id = ?))', [entregaId]);

        await db.query('COMMIT');

        console.log(`[DEBUG] Entrega #${entregaId} marcada como recebida`);
        await bot.sendMessage(chatId, `✅ *Entrega #${entregaId} marcada como recebida.*`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔍 Ver Detalhes de Outro Pedido', callback_data: 'pedidos' }],
              [{ text: '⬅️ Voltar', callback_data: 'submenu_pedidos' }, { text: '🛑 Sair', callback_data: 'sair' }]
            ]
          }
        });
        await listarPedidosPendentes(chatId, sessao, db, bot.sendMessage);

        // Verificar se a rota deve ser finalizada automaticamente
        await verificarFinalizarRotaAutomaticamente(chatId, sessao, db, bot.sendMessage);

        sessao.etapa = null;
        sessao.submenu = 'pedidos';
        sessao.pedidoId = null;
        sessao.pontoInicial = null;
        sessao.locations = [];
        sessao.justificativaSelecionada = null;
        sessoes.set(chatId, sessao);
      } catch (err) {
        await db.query('ROLLBACK');
        console.error(`[ERROR] Erro ao atualizar status da entrega: ${err.message}`);
        await bot.sendMessage(chatId, '⚠️ *Erro ao atualizar status da entrega.*', {
          reply_markup: getSubmenuPedidos()
        });
      }
      return;
    }

    if (data.startsWith('falha_')) {
      await bot.answerCallbackQuery(query.id);
      const entregaId = parseInt(data.split('_')[1]);
      sessao.etapa = 'falha_justificativa';
      sessao.pedidoId = entregaId;
      sessao.pontoInicial = null;
      sessao.locations = [];
      sessao.justificativaSelecionada = null;
      sessao.submenu = 'pedidos';
      sessoes.set(chatId, sessao);
      console.log(`[DEBUG] Aguardando justificativa para falha da entrega #${entregaId}`);
      await bot.sendMessage(chatId, '❗ *Selecione o motivo da falha no recebimento:*', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Cliente Ausente', callback_data: `justificativa_Cliente Ausente` }],
            [{ text: 'Endereço Incorreto', callback_data: `justificativa_Endereço Incorreto` }],
            [{ text: 'Recusado pelo Cliente', callback_data: `justificativa_Recusado pelo Cliente` }],
            [{ text: 'Outro', callback_data: `justificativa_Outro` }],
            [{ text: '🚫 Cancelar', callback_data: 'cancelar_justificativa' }, { text: '🛑 Sair', callback_data: 'sair' }]
          ]
        }
      });
      return;
    }

    if (data === 'cancelar_justificativa') {
      await bot.answerCallbackQuery(query.id);
      sessao.etapa = null;
      sessao.submenu = 'pedidos';
      sessao.pedidoId = null;
      sessao.pontoInicial = null;
      sessao.locations = [];
      sessao.justificativaSelecionada = null;
      sessoes.set(chatId, sessao);
      await listarPedidosPendentes(chatId, sessao, db, bot.sendMessage);
      return;
    }

    // Delegar para organizar rota (já tratado acima por tratarCallbackOrganizarRota)
  });

  // Configurar listener de organizar rota
  configurarOrganizarRota(bot, db, sessoes);
}

module.exports = { tratarEntrega, configurarEntrega };