const axios = require('axios');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
// Função para escapar caracteres especiais no Markdown
const escapeMarkdown = (text) => {
  if (!text) return text || 'Não informado';
  return text.replace(/([*_`[\]])/g, '\\$1');
};

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
    }, 1200000); // 30 seconds
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
    `👋 *Bem-vindo às vendas, ${escapeMarkdown(nomeUsuario || 'Usuário')}!* 😊\nEscolha uma opção:`,
    bot,
    { reply_markup: keyboard }
  );
};

// Handle callback queries
const handleCallbacks = async (query, sessao, bot, db, sessoes) => {
  const chatId = query.message?.chat?.id?.toString();
  const data = query.data;

  if (!chatId || !data) {
    console.error('[ERROR] Invalid callback query:', query);
    await bot.answerCallbackQuery(query.id);
    return sendMessage(chatId, '⚠️ *Erro ao processar ação. Tente novamente.*', bot);
  }

  try {
    if (data === 'criar_venda') {
      sessao.carrinho = [];
      sessao.etapa = 'criar_venda';
      sessao.lastUpdated = Date.now();
      const keyboard = {
        inline_keyboard: [
          [{ text: '➕ Adicionar itens', callback_data: 'adicionar_itens' }],
          [{ text: '🛑 Cancelar', callback_data: 'cancelar' }],
          [{ text: '🛑 Sair', callback_data: 'sair' }],
        ],
      };
      await bot.answerCallbackQuery(query.id);
      return sendMessage(
        chatId,
        `🛒 *Criar nova venda, ${escapeMarkdown(sessao.nome || 'Usuário')}!*\nO que deseja fazer?`,
        bot,
        { reply_markup: keyboard }
      );
    }

    if (data === 'adicionar_itens') {
      sessao.etapa = 'adicionar_itens';
      sessao.lastUpdated = Date.now();
      await bot.answerCallbackQuery(query.id);
      return sendMessage(
        chatId,
        `➕ *Adicione itens ao carrinho.*\nExemplo: 1un banana, 25g capulho gourmet ou combo caneta refil 1`,
        bot
      );
    }

    if (data === 'finalizar') {
      if (!sessao.carrinho?.length) {
        await bot.answerCallbackQuery(query.id);
        return sendMessage(
          chatId,
          '⚠️ *O carrinho está vazio. Adicione itens antes de finalizar.*',
          bot
        );
      }
      sessao.etapa = 'metodo_pagamento';
      sessao.lastUpdated = Date.now();
      const keyboard = {
        inline_keyboard: [
          [{ text: '💸 Pix', callback_data: 'pix' }],
          [{ text: '💵 Dinheiro', callback_data: 'dinheiro' }],
          [{ text: '💵💸 Dinheiro e Pix', callback_data: 'dinheiro_pix' }],
          [{ text: '🛑 Cancelar', callback_data: 'cancelar' }],
        ],
      };
      await bot.answerCallbackQuery(query.id);
      return sendMessage(
        chatId,
        `💳 *Escolha o método de pagamento:*`,
        bot,
        { reply_markup: keyboard }
      );
    }

    if (data === 'cancelar') {
      sessao.carrinho = [];
      sessao.etapa = null;
      sessao.metodo_pagamento = null;
      sessao.comprovante_pagamento = null;
      sessao.numero_cliente = null;
      sessao.lastUpdated = Date.now();
      await bot.answerCallbackQuery(query.id);
      return showInitialMenu(chatId, sessao.nome, bot);
    }

    if (data === 'pix') {
      sessao.metodo_pagamento = 'pix';
      sessao.etapa = 'comprovante';
      sessao.lastUpdated = Date.now();
      const [laranja] = await db.query(`SELECT pix, qrcodex64 FROM laranja WHERE status = 1 LIMIT 1`);
      let mensagem = `📸 *Envie a imagem do comprovante do Pix.*\n`;
      if (laranja.length && laranja[0].pix) {
        mensagem += `Chave Pix: ${escapeMarkdown(laranja[0].pix)}\n`;
      }
      await bot.answerCallbackQuery(query.id);
      return sendMessage(chatId, mensagem, bot);
    }

    if (data === 'dinheiro') {
      sessao.metodo_pagamento = 'dinheiro';
      sessao.comprovante_pagamento = 'Sem comprovante';
      sessao.etapa = 'numero_cliente';
      sessao.lastUpdated = Date.now();
      await bot.answerCallbackQuery(query.id);
      return sendMessage(
        chatId,
        `📞 *Digite o número do cliente.*\nExemplo: +5511999999999 ou 5511999999999`,
        bot
      );
    }

    if (data === 'dinheiro_pix') {
      sessao.metodo_pagamento = 'dinheiro_pix';
      sessao.etapa = 'comprovante';
      sessao.lastUpdated = Date.now();
      const [laranja] = await db.query(`SELECT pix, qrcodex64 FROM laranja WHERE status = 1 LIMIT 1`);
      let mensagem = `📸 *Envie a imagem do comprovante do Pix.*\n`;
      if (laranja.length && laranja[0].pix) {
        mensagem += `Chave Pix: ${escapeMarkdown(laranja[0].pix)}\n`;
      }
      await bot.answerCallbackQuery(query.id);
      return sendMessage(chatId, mensagem, bot);
    }

    if (data === 'confirmar_pedido') {
      if (!sessao.numero_cliente) {
        await bot.answerCallbackQuery(query.id);
        return sendMessage(
          chatId,
          '⚠️ *Por favor, envie o número do cliente antes de confirmar.*',
          bot
        );
      }

      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();

        // Separar itens normais e combos
        const itensNormais = sessao.carrinho.filter(item => !item.isCombo);
        const combos = sessao.carrinho.filter(item => item.isCombo);

        // Processar itens normais
        for (const item of itensNormais) {
          const quantidade = parseFloat(item.quantidade.replace(/[^0-9.]/g, '')) || 0;
          await connection.query(
            `CALL registrar_venda(?, ?, ?, ?, ?)`,
            [
              sessao.numero_cliente,
              sessao.metodo_pagamento,
              sessao.usuario_id,
              item.id,
              quantidade
            ]
          );
        }

        // Processar combos
        for (const combo of combos) {
          const quantidadeCombo = parseFloat(combo.quantidade.replace(/[^0-9.]/g, '')) || 0;
          await connection.query(
            `CALL registrar_venda_combo_caneta_refil(?, ?, ?, ?)`,
            [
              sessao.numero_cliente,
              sessao.metodo_pagamento,
              sessao.usuario_id,
              quantidadeCombo
            ]
          );
        }

        // Salvar comprovante, se houver
        if (sessao.comprovante_pagamento && sessao.comprovante_pagamento !== 'Sem comprovante') {
          const buffer = Buffer.from(sessao.comprovante_pagamento, 'base64');
          if (buffer.length > 10 * 1024 * 1024) {
            throw new Error('Imagem do comprovante muito grande.');
          }
          const [vendasRecentes] = await connection.query(
            `SELECT id FROM vendas WHERE cliente_numero = ? ORDER BY id DESC LIMIT ?`,
            [sessao.numero_cliente, itensNormais.length + combos.length]
          );
          for (const venda of vendasRecentes) {
            await connection.query(
              `UPDATE vendas SET comprovante = ? WHERE id = ?`,
              [buffer, venda.id]
            );
          }
        }

        await connection.commit();

        // Limpar sessão
        sessao.carrinho = [];
        sessao.etapa = null;
        sessao.metodo_pagamento = null;
        sessao.comprovante_pagamento = null;
        sessao.numero_cliente = null;
        sessao.valor_dinheiro = null;
        sessao.lastUpdated = Date.now();

        await bot.answerCallbackQuery(query.id);
        await sendMessage(chatId, `✅ *Venda finalizada com sucesso! Pedido registrado.*`, bot);
        return showInitialMenu(chatId, sessao.nome, bot);
      } catch (err) {
        await connection.rollback();
        console.error(`[ERROR] Erro ao finalizar pedido:`, err.message);
        await bot.answerCallbackQuery(query.id);
        return sendMessage(
          chatId,
          `⚠️ *Erro ao finalizar venda: ${err.message}. Tente novamente.*`,
          bot
        );
      } finally {
        connection.release();
      }
    }

    // Função para gerar a imagem da lista
async function gerarListaImagem(chatId, bot, db) {
  try {
    // Consultar categorias e promoções
    const [categorias] = await db.query(`SELECT DISTINCT categoria FROM estoque WHERE quantidade > 0`);
    const [promocoes] = await db.query(
      `SELECT nome, tipo, preco_promocional, quantidade_minima, produto_id, produto_id_secundario
       FROM promocoes WHERE ativa = 1 AND (data_inicio IS NULL OR data_inicio <= CURDATE())
       AND (data_fim IS NULL OR data_fim >= CURDATE())`
    );

    // Cabeçalho
    let conteudo = `
      <div class="header">
        <h1>Lista Exclusiva</h1>
        <div class="divider">🏌🏼‍♂️🏌🏼‍♂️🏌🏼‍♂️🏌🏼‍♂️🏌🏼‍♂️🏌🏼‍♂️🏌🏼‍♂️🏌🏼‍♂️</div>
        <p><strong>NÃO REPASSE A LISTA!</strong></p>
        <p><strong>ATENDIMENTO: 08:00 às 22:00</strong></p>
        <p><strong>PAGAMENTO: Dinheiro ou PIX antecipado (com comprovante)</strong></p>
        <p><strong>ENTREGA GRÁTIS</strong></p>
      </div>
      <div class="separator"></div>
    `;

    let produtoIndex = 1;

    // Mapear emojis de categorias
    const emojiCategoria = {
      'POD/THC': '🌬️',
      'FLOR/SKUNK/CAPULHO': '🪴',
      'CRUMBLE/WAX/ROSIN': '🍯',
      '#/@/⚡️': '🛞'
    };

    // Mapear subcategorias
    const subcategorias = {
      'Torch - Pebbles': 'Descartáveis',
      'Elf - ELFTHC (Live Rosin 3g)': 'Descartáveis',
      'Elf - ELFTHC (Live Rosin 1g)': 'Refil',
      'Elf - ELFTHC (Caneta Recarregavel)': 'Caneta Recarregavel'
    };

    let ultimaSubcategoria = '';

    for (const cat of categorias) {
      const [produtos] = await db.query(
        `SELECT id, nome, medida, quantidade, valor_unitario, sabores FROM estoque WHERE categoria = ? AND quantidade > 0`,
        [cat.categoria]
      );

      if (produtos.length > 0) {
        conteudo += `<div class="categoria">${emojiCategoria[cat.categoria] || ''} ${cat.categoria}</div><div class="separator"></div>`;

        for (const p of produtos) {
          // Subcategoria
          let subcategoria = subcategorias[p.nome] || '';
          if (subcategoria && subcategoria !== ultimaSubcategoria) {
            conteudo += `<div class="subcategoria">${subcategoria}</div>`;
            ultimaSubcategoria = subcategoria;
          }

          conteudo += `<div class="produto">(${String(produtoIndex).padStart(2, '0')}) • ${p.nome} ${p.medida ? `(${p.medida})` : ''}</div>`;
          conteudo += `<div>R$${parseFloat(p.valor_unitario).toFixed(2)} ${p.medida || 'un'}</div>`;

          // Promoções por quantidade
          const promocoesProduto = promocoes.filter(promo => promo.produto_id === p.id && promo.tipo === 'quantidade');
          for (const promo of promocoesProduto) {
            conteudo += `<div class="promocao">${promo.quantidade_minima} ou mais R$${parseFloat(promo.preco_promocional).toFixed(2)} ${p.medida || 'un'}</div>`;
          }

          // Sabores
          if (p.sabores) {
            conteudo += `<div>(SABORES)</div>`;
            const sabores = p.sabores.split(';');
            for (const sabor of sabores) {
              conteudo += `<div class="sabor">- ${sabor}</div>`;
            }
          }

          conteudo += `<div class="spacer"></div>`;
          produtoIndex++;
        }
      }
    }

    // Seção de promoções (combos)
    const combos = promocoes.filter(promo => promo.tipo === 'combo');
    if (combos.length > 0) {
      conteudo += `<div class="categoria">PROMOÇÃO!!</div><div class="separator"></div>`;
      for (const combo of combos) {
        const [produto1] = await db.query(`SELECT nome FROM estoque WHERE id = ?`, [combo.produto_id]);
        const [produto2] = await db.query(`SELECT nome FROM estoque WHERE id = ?`, [combo.produto_id_secundario]);
        conteudo += `<div class="produto">(${String(produtoIndex).padStart(2, '0')}) ✅ ${combo.nome}: ${produto1[0].nome} + ${produto2[0].nome}</div>`;
        conteudo += `<div class="promocao">R$${parseFloat(combo.preco_promocional).toFixed(2)} ✅</div>`;
        conteudo += `<div class="spacer"></div>`;
        produtoIndex++;
      }
    }

    // Rodapé
    conteudo += `
      <div class="separator"></div>
      <div class="footer">
        <div class="divider">🏌🏼‍♂️🏌🏼‍♂️🏌🏼‍♂️🏌🏼‍♂️🏌🏼‍♂️🏌🏼‍♂️🏌🏼‍♂️🏌🏼‍♂️</div>
        <p><strong>NÃO REPASSE A LISTA!</strong></p>
        <p><strong>ATENDIMENTO: 08:00 às 22:00</strong></p>
        <p><strong>PAGAMENTO: Dinheiro ou PIX antecipado (com comprovante)</strong></p>
        <p><strong>ENTREGA GRÁTIS</strong></p>
      </div>
    `;

    // HTML estilizado para a imagem
    const html = `
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;700;900&display=swap" rel="stylesheet">
        <style>
          body {
            font-family: 'Nunito', sans-serif;
            background: linear-gradient(135deg, #1a73e8, #4a90e2);
            padding: 15px;
            margin: 0;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
          }
          .container {
            background: #fff;
            max-width: 400px;
            border-radius: 15px;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
            padding: 20px;
            color: #333;
            font-size: 14px;
            line-height: 1.4;
          }
          .header h1 {
            font-size: 20px;
            font-weight: 900;
            color: #1a73e8;
            text-align: center;
            margin: 0 0 10px;
            text-transform: uppercase;
          }
          .categoria {
            font-size: 16px;
            font-weight: 700;
            color: #1a73e8;
            margin: 10px 0 5px;
          }
          .subcategoria {
            font-size: 14px;
            font-weight: 700;
            color: #333;
            margin: 8px 0 4px;
          }
          .produto {
            font-weight: 700;
            margin: 4px 0;
          }
          .promocao {
            color: #34c759;
            font-weight: 700;
            margin: 2px 0;
          }
          .sabor {
            color: #666;
            margin: 2px 0;
          }
          .divider {
            text-align: center;
            color: #888;
            font-size: 16px;
            margin: 8px 0;
          }
          .separator {
            height: 1px;
            background: linear-gradient(to right, transparent, #ccc, transparent);
            margin: 8px 0;
          }
          .spacer {
            height: 8px;
          }
          .footer {
            margin-top: 10px;
          }
          p, div {
            margin: 2px 0;
          }
          strong {
            font-weight: 700;
          }
          .emoji {
            font-size: 16px;
            vertical-align: middle;
          }
        </style>
      </head>
      <body>
        <div class="container">${conteudo}</div>
      </body>
      </html>
    `;

    // Inicializar Puppeteer
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(html);
    await page.screenshot({ path: 'lista.png', fullPage: true });
    await browser.close();

    // Enviar a imagem via Telegram
    await bot.sendPhoto(chatId, fs.readFileSync('lista.png'), {
      caption: '📋 *Lista Exclusiva Atualizada*'
    });

    // Limpar arquivo
    if (fs.existsSync('lista.png')) fs.unlinkSync('lista.png');

    return true;
  } catch (err) {
    console.error('[ERROR] Erro ao gerar lista imagem:', err.message);
    await bot.sendMessage(chatId, '⚠️ Erro ao gerar a lista. Tente novamente mais tarde.');
    return false;
  }
}

// Ajuste no trecho do if (data === 'lista')
if (data === 'lista') {
  await bot.answerCallbackQuery(query.id);
  const sucesso = await gerarListaImagem(chatId, bot, db);
  if (sucesso) {
    sessao.etapa = null;
    return showInitialMenu(chatId, sessao.nome, bot);
  }
}

    if (data === 'laranja') {
      const [laranja] = await db.query(`SELECT pix, qrcodex64 FROM laranja WHERE status = 1 LIMIT 1`);
      if (!laranja.length) {
        await bot.answerCallbackQuery(query.id);
        return sendMessage(chatId, '⚠️ *Nenhuma informação de Pix disponível.*', bot);
      }
      const { pix, qrcodex64 } = laranja[0];
      await bot.answerCallbackQuery(query.id);
      if (qrcodex64) {
        try {
          const base64Data = qrcodex64.split(',')[1]; // remove "data:image/png;base64,"
          const buffer = Buffer.from(base64Data, 'base64');
          if (!base64Data) {
            throw new Error('QR code inválido ou mal formatado');
          }

          await bot.sendPhoto(chatId, buffer, {
            caption: `🟠 *Pix para pagamento:*\n${escapeMarkdown(pix)}\n\nUse o QR Code acima ou copie o código Pix.`,
          });
        } catch (err) {
          console.error(`[ERROR] Erro ao enviar QR Code:`, err.message);
          await sendMessage(chatId, `🟠 *Pix: ${escapeMarkdown(pix)}*\n⚠️ *Erro ao exibir QR Code.*`, bot);
        }
      } else {
        await sendMessage(chatId, `🟠 *Pix: ${escapeMarkdown(pix)}*`, bot);
      }
      sessao.etapa = null;
      return showInitialMenu(chatId, sessao.nome, bot);
    }

    if (data === 'info') {
      sessao.etapa = 'info';
      sessao.lastUpdated = Date.now();
      await bot.answerCallbackQuery(query.id);
      return sendMessage(
        chatId,
        `ℹ️ *Digite o nome do produto para consultar.*\nExemplo: coca-cola`,
        bot
      );
    }

    if (data === 'sair') {
      sessao.carrinho = [];
      sessao.etapa = null;
      sessao.setor = null;
      sessao.autenticado = false;
      sessao.lastUpdated = Date.now();
      await bot.answerCallbackQuery(query.id);
      await sendMessage(
        chatId,
        '🛑 *Você saiu do setor Vendas.*\nPara começar, envie *oi* ou sua senha pessoal.',
        bot
      );
    }

    await bot.answerCallbackQuery(query.id);
    return sendMessage(chatId, '⚠️ *Ação inválida. Tente novamente.*', bot);
  } catch (err) {
    console.error(`[ERROR] Erro ao processar callback ${data}:`, err.message);
    await bot.answerCallbackQuery(query.id);
    return sendMessage(chatId, '⚠️ *Erro ao processar ação. Tente novamente.*', bot);
  }
};

// Handle sales-related text messages or photos
const handleSales = async (texto, msg, sessao, db, bot) => {
  const chatId = msg.chat.id.toString();

  // Timeout check
  if (sessao.etapa && Date.now() - sessao.lastUpdated > 5 * 60 * 1000) {
    sessao.carrinho = [];
    sessao.etapa = null;
    sessao.metodo_pagamento = null;
    sessao.comprovante_pagamento = null;
    sessao.numero_cliente = null;
    sessao.lastUpdated = Date.now();
    await sendMessage(
      chatId,
      '🕒 *Sessão expirada. O fluxo foi reiniciado.*\nEscolha uma opção:',
      bot
    );
    return showInitialMenu(chatId, sessao.nome, bot);
  }

  if (texto.toLowerCase() === 'sair') {
    sessao.carrinho = [];
    sessao.etapa = null;
    sessao.setor = null;
    sessao.autenticado = false;
    sessao.lastUpdated = Date.now();
    await sendMessage(
      chatId,
      '🛑 *Você saiu do setor Vendas.*\nPara começar, envie *oi* ou sua senha pessoal.',
      bot
    );
    return showInitialMenu(chatId, sessao.nome, bot);
 }

  if (texto.toLowerCase() === 'produto') {
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
          mensagem += `*${escapeMarkdown(categoria.nome.toUpperCase())}*\n`;
          produtos.forEach(produto => {
            const valorUnitario = parseFloat(produto.valor_unitario);
            const valorFormatado = isNaN(valorUnitario) ? 'Indisponível' : `R$${valorUnitario.toFixed(2)}`;
            mensagem += `- ${escapeMarkdown(produto.nome)} (${produto.medida}): ${produto.quantidade} disponíveis, ${valorFormatado}/${produto.medida}\n`;
          });
          mensagem += '\n';
        }
      }
    }
    await sendMessage(chatId, mensagem || '⚠️ *Nenhum produto disponível no momento.*', bot);
    sessao.etapa = null;
    sessao.lastUpdated = Date.now();
    return showInitialMenu(chatId, sessao.nome, bot);
  }

  if (sessao.etapa === 'adicionar_itens') {
    if (texto.toLowerCase() === 'ver carrinho') {
      if (!sessao.carrinho?.length) {
        await sendMessage(chatId, '🛒 *O carrinho está vazio.*', bot);
        sessao.etapa = null;
        sessao.lastUpdated = Date.now();
        return showInitialMenu(chatId, sessao.nome, bot);
      }
      let mensagem = '🛒 *Seu carrinho:*\n\n';
      let valorTotal = 0;
      sessao.carrinho.forEach(item => {
        const valorTotalItem = parseFloat(item.valor_total);
        const valorFormatado = isNaN(valorTotalItem) ? 'Indisponível' : `R$${valorTotalItem.toFixed(2)}`;
        mensagem += `- ${escapeMarkdown(item.quantidade)} ${escapeMarkdown(item.nome)}: ${valorFormatado}\n`;
        if (!isNaN(valorTotalItem)) {
          valorTotal += valorTotalItem;
        }
      });
      const valorTotalFormatado = isNaN(valorTotal) ? 'Indisponível' : `R$${valorTotal.toFixed(2)}`;
      mensagem += `\n*Valor total:* ${valorTotalFormatado}`;
      const keyboard = {
        inline_keyboard: [
          [{ text: '➕ Adicionar mais itens', callback_data: 'adicionar_itens' }],
          [{ text: '✅ Finalizar', callback_data: 'finalizar' }],
          [{ text: '🛑 Cancelar', callback_data: 'cancelar' }],
        ],
      };
      await sendMessage(chatId, mensagem, bot, { reply_markup: keyboard });
      sessao.lastUpdated = Date.now();
      return;
    }

    if (texto.toLowerCase().startsWith('remover ')) {
      const produto = texto.slice(8).trim().toLowerCase();
      const index = sessao.carrinho.findIndex(item => item.nome.toLowerCase() === produto);
      if (index === -1) {
        await sendMessage(chatId, `⚠️ *Produto ${escapeMarkdown(produto)} não encontrado no carrinho.*`, bot);
        sessao.etapa = null;
        sessao.lastUpdated = Date.now();
        return showInitialMenu(chatId, sessao.nome, bot);
      }
      sessao.carrinho.splice(index, 1);
      sessao.lastUpdated = Date.now();
      await sendMessage(chatId, `🗑️ *${escapeMarkdown(produto)} removido do carrinho.*`, bot);
      sessao.etapa = null;
      return showInitialMenu(chatId, sessao.nome, bot);
    }

    // Suporte para combo Caneta + Refil
    if (texto.toLowerCase().startsWith('combo caneta refil')) {
      const quantidadeMatch = texto.match(/(\d+)/);
      if (!quantidadeMatch) {
        await sendMessage(
          chatId,
          `⚠️ *Formato inválido.* Use: combo caneta refil 1`,
          bot
        );
        sessao.lastUpdated = Date.now();
        return;
      }
      const quantidadeCombo = parseInt(quantidadeMatch[1]);
      if (quantidadeCombo <= 0) {
        await sendMessage(
          chatId,
          `⚠️ *Quantidade inválida para o combo.*`,
          bot
        );
        return;
      }

      // Verificar estoque
      const [estoque] = await db.query(
        `SELECT id, nome, quantidade FROM estoque WHERE id IN (6, 7)`
      );
      const caneta = estoque.find(p => p.id === 6);
      const refil = estoque.find(p => p.id === 7);
      if (!caneta || !refil || caneta.quantidade < quantidadeCombo || refil.quantidade < quantidadeCombo) {
        await sendMessage(
          chatId,
          `⚠️ *Estoque insuficiente para o combo Caneta + Refil.*`,
          bot
        );
        return;
      }

      // Consultar preço do combo
      const [promocao] = await db.query(
        `SELECT preco_promocional FROM promocoes WHERE tipo = 'combo' AND produto_id = 6 AND produto_id_secundario = 7 AND ativa = 1`
      );
      const precoCombo = promocao.length ? parseFloat(promocao[0].preco_promocional) : 400.00; // Preço padrão (150+250)

      sessao.carrinho.push({
        id: 'combo_caneta_refil',
        nome: 'Combo Caneta + Refil',
        quantidade: `${quantidadeCombo}un`,
        valor_unitario: precoCombo,
        valor_total: precoCombo * quantidadeCombo,
        isCombo: true,
        items: [
          { produto_id: 6, quantidade: quantidadeCombo },
          { produto_id: 7, quantidade: quantidadeCombo }
        ]
      });

      const keyboard = {
        inline_keyboard: [
          [{ text: '➕ Adicionar mais itens', callback_data: 'adicionar_itens' }],
          [{ text: '✅ Finalizar', callback_data: 'finalizar' }],
          [{ text: '🛑 Cancelar', callback_data: 'cancelar' }],
        ],
      };
      await sendMessage(
        chatId,
        `✅ ${quantidadeCombo}un Combo Caneta + Refil adicionado ao carrinho por R$${precoCombo.toFixed(2)} cada.`,
        bot,
        { reply_markup: keyboard }
      );
      sessao.lastUpdated = Date.now();
      return;
    }

    // Lógica para itens individuais
    const itens = texto.trim().match(/(\d+\w*)\s+(.+)/);
    if (!itens || itens.length < 3) {
      await sendMessage(
        chatId,
        `⚠️ *Formato inválido.* Use: 1un 25g capulho gourmet ou combo caneta refil 1`,
        bot
      );
      sessao.lastUpdated = Date.now();
      return;
    }

    const quantidadeStr = itens[1];
    const nome = itens[2].toLowerCase();
    const quantidadeMatch = quantidadeStr.match(/(\d+)(?:\w*)/);
    if (!quantidadeMatch) {
      await sendMessage(
        chatId,
        `⚠️ Quantidade inválida para "${escapeMarkdown(nome)}".`,
        bot
      );
      sessao.lastUpdated = Date.now();
      return;
    }

    const quantidade = parseFloat(quantidadeMatch[1]);
    if (isNaN(quantidade) || quantidade <= 0) {
      await sendMessage(
        chatId,
        `⚠️ Quantidade inválida para "${escapeMarkdown(nome)}".`,
        bot
      );
      sessao.lastUpdated = Date.now();
      return;
    }

    // Consultar produto e preço promocional
    const [produtos] = await db.query(
      `SELECT id, nome, medida, quantidade FROM estoque WHERE LOWER(nome) = ?`,
      [nome]
    );

    if (produtos.length === 0) {
      const [estoque] = await db.query(
        `SELECT quantidade FROM estoque WHERE LOWER(nome) = ?`,
        [nome]
      );
      const disponivel = estoque.length > 0 ? estoque[0].quantidade : 0;
      await sendMessage(
        chatId,
        `⚠️ Produto ${escapeMarkdown(nome)} não encontrado ou estoque insuficiente (disponível: ${disponivel}).`,
        bot
      );
      return;
    }

    const produto = produtos[0];
    if (produto.quantidade < quantidade) {
      await sendMessage(
        chatId,
        `⚠️ Estoque insuficiente para ${escapeMarkdown(nome)}. Disponível: ${produto.quantidade}.`,
        bot
      );
      return;
    }


   // Chamar procedimento calcular_preco_promocional
      const [precoResult] = await db.query(
        `CALL calcular_preco_promocional(?, ?)`,
        [produto.id, quantidade]
      );
      const valorUnitario = parseFloat(precoResult[0][0].preco_unitario);
      if (isNaN(valorUnitario)) {
        await sendMessage(
          chatId,
          `⚠️ Valor unitário inválido para "${escapeMarkdown(nome)}".`,
          bot
        );
        return;
      }

    const valorTotal = quantidade * valorUnitario;
    sessao.carrinho.push({
      id: produto.id,
      nome: produto.nome,
      quantidade: `${quantidade}${produto.medida}`,
      valor_unitario: valorUnitario,
      valor_total: valorTotal,
      isCombo: false
    });

    const keyboard = {
      inline_keyboard: [
        [{ text: '➕ Adicionar mais itens', callback_data: 'adicionar_itens' }],
        [{ text: '✅ Finalizar', callback_data: 'finalizar' }],
        [{ text: '🛑 Cancelar', callback_data: 'cancelar' }],
      ],
    };
    await sendMessage(
      chatId,
      `✅ ${quantidade}${produto.medida} ${escapeMarkdown(produto.nome)} adicionado ao carrinho por R$${valorUnitario.toFixed(2)} cada.`,
      bot,
      { reply_markup: keyboard }
    );
    sessao.lastUpdated = Date.now();
    return;
  }

  if (sessao.etapa === 'comprovante') {
    if (texto && texto.toLowerCase() === 'sem comprovante') {
      sessao.comprovante_pagamento = 'Sem comprovante';
      sessao.etapa = sessao.metodo_pagamento === 'dinheiro_pix' ? 'valor_dinheiro' : 'numero_cliente';
      sessao.lastUpdated = Date.now();
      const mensagem = sessao.metodo_pagamento === 'dinheiro_pix'
        ? `💵 *Digite o valor a ser pago em dinheiro.*\nExemplo: 50.00`
        : `📞 *Digite o número do cliente.*\nExemplo: +5511999999999 ou 5511999999999`;
      await sendMessage(chatId, mensagem, bot);
      return;
    }
    if (msg.photo && msg.photo.length > 0) {
      const photo = msg.photo[msg.photo.length - 1];
      try {
        const file = await bot.getFile(photo.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 10000 });
        const imageBuffer = Buffer.from(response.data);
        if (imageBuffer.length > 10 * 1024 * 1024) {
          throw new Error('Imagem muito grande (máximo 10MB).');
        }

        const saveDir = './comprovantes';
        if (!fs.existsSync(saveDir)) {
          fs.mkdirSync(saveDir, { recursive: true });
        }
        const fileName = `${chatId}_${Date.now()}_${photo.file_id}.jpg`;
        const filePath = path.join(saveDir, fileName);
        fs.writeFileSync(filePath, imageBuffer);
        console.log(`[DEBUG] Imagem salva em: ${filePath}`);

        sessao.comprovante_pagamento = imageBuffer.toString('base64');
        sessao.etapa = sessao.metodo_pagamento === 'dinheiro_pix' ? 'valor_dinheiro' : 'numero_cliente';
        sessao.lastUpdated = Date.now();
        const mensagem = sessao.metodo_pagamento === 'dinheiro_pix'
          ? `💵 *Digite o valor a ser pago em dinheiro.*\nExemplo: 50.00`
          : `📞 *Digite o número do cliente.*\nExemplo: +5511999999999 ou 5511999999999`;
        await sendMessage(chatId, mensagem, bot);
        return;
      } catch (err) {
        console.error(`[ERROR] Erro ao processar imagem do comprovante:`, err.message);
        await sendMessage(
          chatId,
          `⚠️ *Erro ao processar a imagem: ${err.message}. Tente novamente ou envie "sem comprovante".*`,
          bot
        );
        sessao.lastUpdated = Date.now();
        return;
      }
    }
    await sendMessage(
      chatId,
      `📸 *Envie a imagem do comprovante ou digite "sem comprovante".*`,
      bot
    );
    sessao.lastUpdated = Date.now();
    return;
  }

  if (sessao.etapa === 'valor_dinheiro') {
    const valorDinheiro = parseFloat(texto.replace(/[^0-9.]/g, ''));
    if (isNaN(valorDinheiro) || valorDinheiro < 0) {
      await sendMessage(
        chatId,
        `⚠️ *Valor inválido. Digite um valor válido em dinheiro.*\nExemplo: 50.00`,
        bot
      );
      sessao.lastUpdated = Date.now();
      return;
    }
    sessao.valor_dinheiro = valorDinheiro;
    sessao.etapa = 'numero_cliente';
    sessao.lastUpdated = Date.now();
    await sendMessage(
      chatId,
      `📞 *Digite o número do cliente.*\nExemplo: +5511999999999 ou 5511999999999`,
      bot
    );
    return;
  }

  if (sessao.etapa === 'numero_cliente') {
    const numero = texto.replace(/\D/g, '');
    if (numero.length < 10 || numero.length > 15) {
      await sendMessage(
        chatId,
        `⚠️ *Número inválido. Digite um número válido com 10 a 15 dígitos.*\nExemplo: +5511999999999 ou 5511999999999`,
        bot
      );
      sessao.lastUpdated = Date.now();
      return;
    }
    sessao.numero_cliente = escapeMarkdown(numero);
    sessao.lastUpdated = Date.now();
    const keyboard = {
      inline_keyboard: [
        [{ text: '✅ Confirmar pedido', callback_data: 'confirmar_pedido' }],
        [{ text: '🛑 Cancelar', callback_data: 'cancelar' }],
      ],
    };
    let mensagem = `📋 *Resumo do pedido:*\n\n`;
    let valorTotal = 0;
    sessao.carrinho.forEach(item => {
      const valorTotalItem = parseFloat(item.valor_total);
      const valorFormatado = isNaN(valorTotalItem) ? 'Indisponível' : `R$${valorTotalItem.toFixed(2)}`;
      mensagem += `- ${escapeMarkdown(item.quantidade)} ${escapeMarkdown(item.nome)}: ${valorFormatado}\n`;
      if (!isNaN(valorTotalItem)) {
        valorTotal += valorTotalItem;
      }
    });
    const valorTotalFormatado = isNaN(valorTotal) ? 'Indisponível' : `R$${valorTotal.toFixed(2)}`;
    mensagem += `\n*Valor total:* ${valorTotalFormatado}\n`;
    mensagem += `*Pagamento:* ${escapeMarkdown(sessao.metodo_pagamento || 'Não informado')}\n`;
    if (sessao.metodo_pagamento === 'dinheiro_pix' && sessao.valor_dinheiro !== undefined) {
      mensagem += `*Valor em dinheiro:* R$${sessao.valor_dinheiro.toFixed(2)}\n`;
    }
    mensagem += `*Número do cliente:* ${escapeMarkdown(sessao.numero_cliente)}`;
    await sendMessage(chatId, mensagem, bot, { reply_markup: keyboard });
    return;
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
      await sendMessage(
        chatId,
        `⚠️ *Produto ${escapeMarkdown(nomeProduto)} não encontrado.*`,
        bot
      );
      sessao.etapa = null;
      sessao.lastUpdated = Date.now();
      return showInitialMenu(chatId, sessao.nome, bot);
    }
    const produto = produtos[0];
    const valorUnitario = parseFloat(produto.valor_unitario);
    const valorFormatado = isNaN(valorUnitario) ? 'Indisponível' : `R$${valorUnitario.toFixed(2)}`;
    const mensagem = `ℹ️ *Informações do produto:*\n\n` +
      `- *Nome:* ${escapeMarkdown(produto.nome)}\n` +
      `- *Medida:* ${produto.medida}\n` +
      `- *Quantidade disponível:* ${produto.quantidade}\n` +
      `- *Valor unitário:* ${valorFormatado}/${produto.medida}`;
    await sendMessage(chatId, mensagem, bot);
    sessao.etapa = null;
    sessao.lastUpdated = Date.now();
    return showInitialMenu(chatId, sessao.nome, bot);
  }

  sessao.etapa = null;
  sessao.lastUpdated = Date.now();
  return showInitialMenu(chatId, sessao.nome, bot);
};

// Exportar função compatível com chatbot.js
module.exports = async (texto, msg, sessao, db, bot, sessoes) => {
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
  return handleCallbacks(texto, sessao, bot, db, sessoes);
  }

  // Inicializar texto como string vazia se não definido
  texto = texto || msg.text || '';
  if (temImagem || typeof texto === 'string') {
    return handleSales(texto, msg, sessao, db, bot);
  }

  console.log('[DEBUG] Mensagem inválida recebida:', msg);
  await sendMessage(
    msg.chat.id.toString(),
    '⚠️ *Mensagem não reconhecida. Envie texto ou imagem do comprovante.*',
    bot
  );
  sessao.etapa = null;
  sessao.lastUpdated = Date.now();
  return showInitialMenu(msg.chat.id.toString(), sessao.nome, bot);
};