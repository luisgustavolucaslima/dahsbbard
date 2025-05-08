const axios = require('axios');

// Utility function for sending messages with auto-deletion
const sendMessage = async (chatId, mensagem, bot, options = {}) => {
  try {
    if (!chatId || !mensagem) {
      console.error('[ERROR] Invalid parameters for sendMessage:', { chatId, mensagem });
      return null;
    }
    const sentMessage = await bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown', ...options });
    setTimeout(async () => {
      try {
        await bot.deleteMessage(chatId, sentMessage.message_id);
      } catch (err) {
        console.error(`[ERROR] Failed to delete message ${sentMessage.message_id}:`, err.message);
      }
    }, 30000);
    return sentMessage;
  } catch (err) {
    console.error(`[ERROR] Failed to send message to ${chatId}:`, err.message);
    return null;
  }
};

// Display initial menu
const showInitialMenu = async (chatId, nomeUsuario, bot) => {
  const keyboard = {
    inline_keyboard: [
      [
        { text: '🛒 Criar venda', callback_data: 'criar_venda' },
        { text: '📋 Lista', callback_data: 'lista' },
      ],
      [
        { text: '🟠 Laranja', callback_data: 'laranja' },
        { text: 'ℹ️ Info', callback_data: 'info' },
      ],
      [{ text: '🛑 Sair', callback_data: 'sair' }],
    ],
  };
  return sendMessage(
    chatId,
    `👋 *Bem-vindo às vendas, ${nomeUsuario || 'Usuário'}!* 😊\nEscolha uma opção:`,
    bot,
    { reply_markup: keyboard }
  );
};

// Handle callback queries
const handleCallbacks = async (query, sessao, bot, db) => {
  const chatId = query.message?.chat?.id?.toString();
  const data = query.data;

  if (!chatId || !data) {
    console.error('[ERROR] Invalid callback query:', query);
    return sendMessage(chatId, '⚠️ *Erro ao processar ação. Tente novamente.*', bot);
  }

  try {
    if (data === 'criar_venda') {
      sessao.carrinho = [];
      sessao.etapa = 'criar_venda';
      const keyboard = {
        inline_keyboard: [
          [{ text: '➕ Adicionar itens', callback_data: 'adicionar_itens' }],
          [{ text: '🛑 Cancelar', callback_data: 'cancelar' }],
          [{ text: '🛑 Sair', callback_data: 'sair' }],
        ],
      };
      return sendMessage(
        chatId,
        `🛒 *Criar nova venda, ${sessao.nome || 'Usuário'}!*\nO que deseja fazer?`,
        bot,
        { reply_markup: keyboard }
      );
    }

    if (data === 'adicionar_itens') {
      sessao.etapa = 'adicionar_itens';
      return sendMessage(
        chatId,
        `➕ *Adicione itens ao carrinho.*\nExemplo: 1kg banana 1un coca-cola\nOu use: *ver carrinho*, *remover banana*`,
        bot
      );
    }

    if (data === 'finalizar') {
      if (!sessao.carrinho?.length) {
        return sendMessage(
          chatId,
          '⚠️ *O carrinho está vazio. Adicione itens antes de finalizar.*',
          bot
        );
      }
      sessao.etapa = 'finalizar';
      return sendMessage(
        chatId,
        `📍 *Por favor, envie o endereço de entrega ou a localização.*`,
        bot
      );
    }

    if (data === 'cancelar') {
      sessao.carrinho = [];
      sessao.etapa = null;
      return showInitialMenu(chatId, sessao.nome, bot);
    }

    if (data === 'pix') {
      sessao.metodo_pagamento = 'pix';
      sessao.etapa = 'comprovante';
      const [laranja] = await db.query(`SELECT pix, qrcodex64 FROM laranja WHERE status = 1 LIMIT 1`);
      let mensagem = `📸 *Envie a imagem do comprovante do Pix.*\n`;
      return sendMessage(chatId, mensagem, bot);
    }

    if (data === 'dinheiro') {
      sessao.metodo_pagamento = 'dinheiro';
      sessao.comprovante_pagamento = 'Sem comprovante';
      sessao.etapa = 'numero_cliente';
      return sendMessage(
        chatId,
        `📞 *Digite o número do cliente.*\nExemplo: 5511999999999`,
        bot
      );
    }

    if (data === 'dinheiro_pix') {
      sessao.metodo_pagamento = 'dinheiro_pix';
      sessao.etapa = 'comprovante';
      const [laranja] = await db.query(`SELECT pix, qrcodex64 FROM laranja WHERE status = 1 LIMIT 1`);
      let mensagem = `📸 *Envie a imagem do comprovante do Pix.*\n`;
      return sendMessage(chatId, mensagem, bot);
    }

    if (data === 'confirmar_pedido') {
      if (!sessao.numero_cliente) {
        return sendMessage(
          chatId,
          '⚠️ *Por favor, envie o número do cliente antes de confirmar.*',
          bot
        );
      }

      const carrinho = sessao.carrinho || [];
      const valorTotal = carrinho.reduce((total, item) => total + (item.valor_total || 0), 0);

      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();

        // Validate all products in the cart
        const productNames = carrinho.map(item => item.nome.trim().toLowerCase());
        const [estoque] = await connection.query(
          `SELECT nome, quantidade, valor_unitario, id
           FROM estoque
           WHERE LOWER(nome) IN (${productNames.map(() => '?').join(',')})`,
          productNames
        );

        for (const item of carrinho) {
          const estoqueItem = estoque.find(e => e.nome.toLowerCase() === item.nome.toLowerCase());
          if (!estoqueItem) {
            throw new Error(`Produto ${item.nome} não encontrado no estoque.`);
          }
          const quantidade = parseFloat(item.quantidade.toString().replace(/[^0-9.]/g, '')) || 0;
          if (estoqueItem.quantidade < quantidade) {
            throw new Error(
              `Estoque insuficiente para ${item.nome}. Disponível: ${estoqueItem.quantidade}, solicitado: ${quantidade}`
            );
          }
        }

        // Save sale in vendas table
        const [result] = await connection.query(
          `INSERT INTO vendas (cliente_numero, forma_pagamento, valor_total, endereco, recebido, status, data, vendedor_id)
           VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)`,
          [
            sessao.numero_cliente || 'Não informado',
            sessao.metodo_pagamento || 'Não informado',
            valorTotal || 0,
            sessao.endereco || 'Não informado',
            0,
            'novo',
            sessao.usuario_id || null,
          ]
        );
        const vendaId = result.insertId;
        console.log(`[DEBUG] Venda salva com ID: ${vendaId}`);

        // Save order in pedidos_diarios table
        const [pedidoResult] = await connection.query(
          `INSERT INTO pedidos_diarios (cliente_numero, status, endereco, recebido, venda_id)
           VALUES (?, ?, ?, ?, ?)`,
          [
            sessao.numero_cliente || 'Não informado',
            'novo',
            sessao.endereco || 'Não informado',
            0,
            vendaId,
          ]
        );
        const pedidoId = pedidoResult.insertId;
        console.log(`[DEBUG] Pedido diário salvo com ID: ${pedidoId}`);

        // Save order items in pedido_itens table
        const itemQueries = carrinho.map(item => {
          const quantidade = parseFloat(item.quantidade.toString().replace(/[^0-9.]/g, '')) || 0;
          return connection.query(
            `INSERT INTO pedido_itens (pedido_id, produto_id, quantidade)
             VALUES (?, ?, ?)`,
            [pedidoId, item.id, quantidade]
          );
        });
        await Promise.all(itemQueries);
        console.log(`[DEBUG] Itens adicionados ao pedido: ${carrinho.length} itens`);

        // Update stock
        const stockQueries = carrinho.map(item => {
          const quantidade = parseFloat(item.quantidade.toString().replace(/[^0-9.]/g, '')) || 0;
          const nomeProduto = item.nome.trim().toLowerCase();
          return connection.query(
            `UPDATE estoque SET quantidade = quantidade - ? WHERE LOWER(nome) = ?`,
            [quantidade, nomeProduto]
          );
        });
        await Promise.all(stockQueries);
        console.log(`[DEBUG] Estoque atualizado para ${carrinho.length} produtos`);

        // Save payment receipt
        if (sessao.comprovante_pagamento && sessao.comprovante_pagamento !== 'Sem comprovante') {
          const buffer = Buffer.from(sessao.comprovante_pagamento, 'base64');
          await connection.query(
            `UPDATE vendas SET comprovante = ? WHERE id = ?`,
            [buffer, vendaId]
          );
          console.log(`[DEBUG] Comprovante salvo para venda ID: ${vendaId}`);
        }

        await connection.commit();
        console.log(`[DEBUG] Transação concluída com sucesso.`);

        // Clear session
        sessao.carrinho = [];
        sessao.etapa = null;
        sessao.endereco = null;
        sessao.metodo_pagamento = null;
        sessao.comprovante_pagamento = null;
        sessao.numero_cliente = null;

        await sendMessage(chatId, `✅ *Venda finalizada com sucesso! Pedido registrado.*`, bot);
        return showInitialMenu(chatId, sessao.nome, bot);
      } catch (err) {
        await connection.rollback();
        console.error(`[ERROR] Erro ao finalizar pedido:`, err.message);
        return sendMessage(
          chatId,
          `⚠️ *Erro ao finalizar venda: ${err.message}. Tente novamente.*`,
          bot
        );
      } finally {
        connection.release();
      }
    }

    if (data === 'lista') {
      const [categorias] = await db.query(`SELECT id, nome FROM categorias_estoque`);
      let mensagem = '📋 *Lista de produtos por categoria:*\n\n';
      if (!categorias || categorias.length === 0) {
        mensagem += '⚠️ *Nenhuma categoria disponível no momento.*';
      } else {
        for (const categoria of categorias) {
          const [produtos] = await db.query(
            `SELECT nome, medida, quantidade, valor_unitario
             FROM estoque
             WHERE categoria_id = ? AND quantidade > 0`,
            [categoria.id]
          );
          if (produtos && produtos.length > 0) {
            mensagem += `*${categoria.nome.toUpperCase()}*\n`;
            produtos.forEach(produto => {
              mensagem += `- ${produto.nome} (${produto.medida}): ${produto.quantidade} disponíveis, R$${produto.valor_unitario.toFixed(2)}/${produto.medida}\n`;
            });
            mensagem += '\n';
          }
        }
      }
      return sendMessage(chatId, mensagem || '⚠️ *Nenhum produto disponível no momento.*', bot);
    }

    if (data === 'laranja') {
      const [laranja] = await db.query(`SELECT pix, qrcodex64 FROM laranja WHERE status = 1 LIMIT 1`);
      if (!laranja || !laranja.length) {
        return sendMessage(chatId, '⚠️ *Nenhuma informação de Pix disponível.*', bot);
      }
      const { pix, qrcodex64 } = laranja[0];
      if (qrcodex64) {
        try {
          const buffer = Buffer.from(qrcodex64, 'base64');
          await bot.sendPhoto(chatId, buffer, {
            caption: `🟠 *Pix para pagamento:*\n${pix}\n\nUse o QR Code acima ou copie o código Pix.`,
          });
        } catch (err) {
          console.error(`[ERROR] Erro ao enviar QR Code:`, err.message);
          await sendMessage(chatId, `🟠 *Pix: ${pix}*\n⚠️ *Erro ao exibir QR Code.*`, bot);
        }
      } else {
        await sendMessage(chatId, `🟠 *Pix: ${pix}*`, bot);
      }
      return;
    }

    if (data === 'info') {
      sessao.etapa = 'info';
      return sendMessage(
        chatId,
        `ℹ️ *Digite o nome do produto para consultar.*\nExemplo: info coca-cola`,
        bot
      );
    }

    return sendMessage(chatId, '⚠️ *Ação inválida. Tente novamente.*', bot);
  } catch (err) {
    console.error(`[ERROR] Erro ao processar callback ${data}:`, err.message);
    return sendMessage(chatId, '⚠️ *Erro ao processar ação. Tente novamente.*', bot);
  }
};

// Handle sales-related text messages or photos
const handleSales = async (texto, msg, sessao, db, bot) => {
  const chatId = msg.chat.id.toString();

  if (texto.toLowerCase() === 'sair') {
    sessao.carrinho = [];
    sessao.etapa = null;
    sessao.setor = null;
    sessao.autenticado = false;
    return sendMessage(
      chatId,
      '🛑 *Você saiu do setor Vendas.*\nPara começar, envie *oi* ou sua senha pessoal.',
      bot
    );
  }

  if (sessao.etapa === 'adicionar_itens') {
    if (texto.toLowerCase() === 'ver carrinho') {
      if (!sessao.carrinho?.length) {
        return sendMessage(chatId, '🛒 *O carrinho está vazio.*', bot);
      }
      let mensagem = '🛒 *Seu carrinho:*\n\n';
      let valorTotal = 0;
      sessao.carrinho.forEach(item => {
        mensagem += `- ${item.quantidade} ${item.nome}: R$${item.valor_total.toFixed(2)}\n`;
        valorTotal += item.valor_total;
      });
      mensagem += `\n*Valor total:* R$${valorTotal.toFixed(2)}`;
      const keyboard = {
        inline_keyboard: [
          [{ text: '➕ Adicionar mais itens', callback_data: 'adicionar_itens' }],
          [{ text: '✅ Finalizar', callback_data: 'finalizar' }],
          [{ text: '🛑 Cancelar', callback_data: 'cancelar' }],
        ],
      };
      return sendMessage(chatId, mensagem, bot, { reply_markup: keyboard });
    }

    if (texto.toLowerCase().startsWith('remover ')) {
      const produto = texto.slice(8).trim().toLowerCase();
      const index = sessao.carrinho.findIndex(item => item.nome.toLowerCase() === produto);
      if (index === -1) {
        return sendMessage(chatId, `⚠️ *Produto ${produto} não encontrado no carrinho.*`, bot);
      }
      sessao.carrinho.splice(index, 1);
      return sendMessage(chatId, `🗑️ *${produto} removido do carrinho.*`, bot);
    }

    const itens = texto.split(/\s+/);
    let mensagem = '';
    for (let i = 0; i < itens.length; i += 2) {
      const quantidadeStr = itens[i];
      const nome = itens[i + 1]?.toLowerCase();
      if (!nome || !quantidadeStr) {
        mensagem += `⚠️ Formato inválido para "${quantidadeStr} ${nome || ''}". Use: 1kg banana\n`;
        continue;
      }
      const quantidade = parseFloat(quantidadeStr.replace(/[^0-9.]/g, ''));
      if (isNaN(quantidade) || quantidade <= 0) {
        mensagem += `⚠️ Quantidade inválida para "${nome}".\n`;
        continue;
      }
      const [produtos] = await db.query(
        `SELECT id, nome, medida, quantidade, valor_unitario
         FROM estoque
         WHERE LOWER(nome) = ? AND quantidade >= ?`,
        [nome, quantidade]
      );
      if (produtos.length === 0) {
        mensagem += `⚠️ Produto ${nome} não encontrado ou estoque insuficiente.\n`;
        continue;
      }
      const produto = produtos[0];
      const valorTotal = quantidade * produto.valor_unitario;
      sessao.carrinho.push({
        id: produto.id,
        nome: produto.nome,
        quantidade: `${quantidade}${produto.medida}`,
        valor_unitario: produto.valor_unitario,
        valor_total: valorTotal,
      });
      mensagem += `✅ ${quantidade}${produto.medida} ${produto.nome} adicionado ao carrinho.\n`;
    }
    const keyboard = {
      inline_keyboard: [
        [{ text: '➕ Adicionar mais itens', callback_data: 'adicionar_itens' }],
        [{ text: '✅ Finalizar', callback_data: 'finalizar' }],
        [{ text: '🛑 Cancelar', callback_data: 'cancelar' }],
      ],
    };
    return sendMessage(
      chatId,
      mensagem || '⚠️ *Nenhum item válido adicionado.*',
      bot,
      { reply_markup: keyboard }
    );
  }

  if (sessao.etapa === 'finalizar') {
    if (msg.location) {
      sessao.endereco = `Localização: ${msg.location.latitude}, ${msg.location.longitude}`;
    } else {
      sessao.endereco = texto;
    }
    sessao.etapa = 'metodo_pagamento';
    const keyboard = {
      inline_keyboard: [
        [{ text: '💸 Pix', callback_data: 'pix' }],
        [{ text: '💵 Dinheiro', callback_data: 'dinheiro' }],
        [{ text: '💵💸 Dinheiro e Pix', callback_data: 'dinheiro_pix' }],
        [{ text: '🛑 Cancelar', callback_data: 'cancelar' }],
      ],
    };
    return sendMessage(
      chatId,
      `💳 *Escolha o método de pagamento:*`,
      bot,
      { reply_markup: keyboard }
    );
  }

  if (sessao.etapa === 'comprovante') {
    if (texto && texto.toLowerCase() === 'sem comprovante') {
      sessao.comprovante_pagamento = 'Sem comprovante';
      sessao.etapa = 'numero_cliente';
      return sendMessage(
        chatId,
        `📞 *Digite o número do cliente.*\nExemplo: 5511999999999`,
        bot
      );
    }
    // Processar imagem se enviada
    if (msg.photo && msg.photo.length > 0) {
      const photo = msg.photo[msg.photo.length - 1]; // Última versão (maior resolução)
      try {
        const file = await bot.getFile(photo.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        const imageBuffer = Buffer.from(response.data);

        // Salvar a imagem no sistema de arquivos
        const fs = require('fs');
        const path = require('path');
        const saveDir = './comprovantes';
        if (!fs.existsSync(saveDir)) {
          fs.mkdirSync(saveDir, { recursive: true });
        }
        const fileName = `${chatId}_${Date.now()}_${photo.file_id}.jpg`;
        const filePath = path.join(saveDir, fileName);
        fs.writeFileSync(filePath, imageBuffer);
        console.log(`[DEBUG] Imagem salva em: ${filePath}`);

        // Converter para base64 e armazenar na sessão
        sessao.comprovante_pagamento = imageBuffer.toString('base64');
        sessao.etapa = 'numero_cliente';
        return sendMessage(
          chatId,
          `📞 *Digite o número do cliente.*\nExemplo: 5511999999999`,
          bot
        );
      } catch (err) {
        console.error(`[ERROR] Erro ao processar imagem do comprovante:`, err.message);
        return sendMessage(
          chatId,
          `⚠️ *Erro ao processar a imagem. Tente novamente ou envie "sem comprovante".*`,
          bot
        );
      }
    }
    return sendMessage(
      chatId,
      `📸 *Envie a imagem do comprovante ou digite "sem comprovante".*`,
      bot
    );
  }

  if (sessao.etapa === 'numero_cliente') {
    const numero = texto.replace(/\D/g, '');
    if (numero.length < 10) {
      return sendMessage(
        chatId,
        `⚠️ *Número inválido. Digite um número válido.*\nExemplo: 5511999999999`,
        bot
      );
    }
    sessao.numero_cliente = numero;
    const keyboard = {
      inline_keyboard: [
        [{ text: '✅ Confirmar pedido', callback_data: 'confirmar_pedido' }],
        [{ text: '🛑 Cancelar', callback_data: 'cancelar' }],
      ],
    };
    let mensagem = `📋 *Resumo do pedido:*\n\n`;
    let valorTotal = 0;
    sessao.carrinho.forEach(item => {
      mensagem += `- ${item.quantidade} ${item.nome}: R$${item.valor_total.toFixed(2)}\n`;
      valorTotal += item.valor_total;
    });
    mensagem += `\n*Valor total:* R$${valorTotal.toFixed(2)}\n`;
    mensagem += `*Endereço:* ${sessao.endereco || 'Não informado'}\n`;
    mensagem += `*Pagamento:* ${sessao.metodo_pagamento || 'Não informado'}\n`;
    mensagem += `*Número do cliente:* ${sessao.numero_cliente}\n`;
    mensagem += `*Comprovante:* ${sessao.comprovante_pagamento ? 'Enviado' : 'Sem comprovante'}`;
    return sendMessage(chatId, mensagem, bot, { reply_markup: keyboard });
  }

  if (sessao.etapa === 'info') {
    const nomeProduto = texto.toLowerCase().replace('info ', '');
    const [produtos] = await db.query(
      `SELECT nome, medida, quantidade, valor_unitario
       FROM estoque
       WHERE LOWER(nome) = ?`,
      [nomeProduto]
    );
    if (produtos.length === 0) {
      return sendMessage(
        chatId,
        `⚠️ *Produto ${nomeProduto} não encontrado.*`,
        bot
      );
    }
    const produto = produtos[0];
    const mensagem = `ℹ️ *Informações do produto:*\n\n` +
      `- *Nome:* ${produto.nome}\n` +
      `- *Medida:* ${produto.medida}\n` +
      `- *Quantidade disponível:* ${produto.quantidade}\n` +
      `- *Valor unitário:* R$${produto.valor_unitario.toFixed(2)}/${produto.medida}`;
    return sendMessage(chatId, mensagem, bot);
  }

  return showInitialMenu(chatId, sessao.nome, bot);
};

// Exportar função compatível com chatbot.js
module.exports = async (texto, msg, sessao, db, bot) => {
  if (!sessao) {
    console.error('[ERROR] Sessão não definida ao chamar vendas.js');
    return sendMessage(
      msg.chat.id.toString(),
      '⚠️ *Erro interno: sessão não encontrada. Tente novamente.*',
      bot
    );
  }

  const temImagem = msg.photo && msg.photo.length > 0;
  const ehCallback = typeof texto === 'object' && texto.data;

  // [DEBUG] Mostrar informações úteis
  console.log('[DEBUG] Etapa atual:', sessao.etapa);
  console.log('[DEBUG] Texto:', texto);
  console.log('[DEBUG] Tem imagem:', temImagem);

  if (ehCallback) {
    return handleCallbacks(texto, sessao, bot, db);
  }

  // Inicializar texto como string vazia se não definido
  texto = texto || msg.text || '';
  // Permitir tratar imagem mesmo se texto for undefined
  if (temImagem || typeof texto === 'string') {
    return handleSales(texto, msg, sessao, db, bot);
  }

  console.log('[DEBUG] Mensagem inválida recebida:', msg);
  return sendMessage(
    msg.chat.id.toString(),
    '⚠️ *Mensagem não reconhecida. Envie texto ou imagem do comprovante.*',
    bot
  );
};