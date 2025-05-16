const moment = require('moment');

module.exports = async function tratarVendas(texto, msg, sessao, db, client) {
  // Inicializa subetapa e normaliza texto
  if (!sessao.subetapa) sessao.subetapa = null;
  const textoNormalizado = texto.trim().toLowerCase();

  // 1) Comandos gerais antes de iniciar o pedido
  if (!sessao.pedido) {
    // PIX QR Code
    if (textoNormalizado === 'laranja') {
      try {
        const [pixRows] = await db.query(
          "SELECT pix, qrcodex64 FROM laranja WHERE status = true LIMIT 1"
        );
        if (!pixRows.length) return msg.reply('⚠️ Nenhum QR Code ativo encontrado.');
        await msg.reply(`🟠 PIX: ${pixRows[0].pix}`);
        return client.sendMessage(
          msg.from,
          Buffer.from(pixRows[0].qrcodex64, 'base64'),
          { caption: '🧾 QR Code PIX' }
        );
      } catch (err) {
        console.error('Erro ao buscar PIX:', err);
        return msg.reply('⚠️ Erro ao obter QR Code.');
      }
    }
   // Lista 
   if (!sessao.pedido && textoNormalizado === 'lista') {
    try {
      const [produtos] = await db.query(
        'SELECT nome, categoria, icone_categoria, valor_unitario FROM estoque ORDER BY categoria, nome'
      );
      if (!produtos.length) return msg.reply('📦 Nenhum produto em estoque.');
      
      const categorias = {};
      const icones = {};
      
      for (const produto of produtos) {
        const categoria = produto.categoria || 'Sem categoria';
        if (!categorias[categoria]) categorias[categoria] = [];
        if (!icones[categoria]) icones[categoria] = produto.icone || '📦';
      
        // <— aqui a conversão antes do toFixed
        const preco = parseFloat(produto.valor_unitario) || 0;
        categorias[categoria].push(`${produto.nome} - R$ ${preco.toFixed(2)}`);
      }
      
  
      let resposta = [
        '🏌🏼‍♂️'.repeat(13),
        '**FAVOR, LEIA COM ATENÇÃO!**',
        '**NÃO REPASSE A LISTA!**',
        '**ATENDIMENTO DE SEGUNDA A SÁBADO, DAS 08:00 às 22:00!**',
        '**EVITE PIX! PREFERÊNCIA NO DINHEIRO!**',
        '**PIX SÓ ANTECIPADO! FAVOR ENVIAR O COMPROVANTE!**',
        '**ANTES DE FAZER O PIX PEÇA A CHAVE!**',
        '**PEDIDO MÍNIMO R$50,00!**',
        '**APENAS PEDIDO ANTECIPADO, NÃO ATENDEMOS A PRONTA ENTREGA!**',
        '**HORÁRIO DE ENTREGA VARIÁVEL!**',
        '**ENTREGA GRÁTIS**\n'
      ];
  
      // Loop pelas categorias e itens
      for (const [categoria, itens] of Object.entries(categorias)) {
        resposta.push(`\n${icones[categoria]} *${categoria}*`);
        resposta.push(...itens.map(item => `• ${item}`));
      }
  
      resposta.push('\n' + '🏌🏼‍♂️'.repeat(13));
      resposta.push('**FAVOR, LEIA COM ATENÇÃO!**');
      resposta.push('**NÃO REPASSE A LISTA!**');
      resposta.push('**ATENDIMENTO DE SEGUNDA A SÁBADO, DAS 08:00 às 23:00!**');
      resposta.push('**EVITE PIX! PREFERÊNCIA NO DINHEIRO!**');
      resposta.push('**PIX SÓ ANTECIPADO! FAVOR ENVIAR O COMPROVANTE!**');
      resposta.push('**ANTES DE FAZER O PIX PEÇA A CHAVE!**');
      resposta.push('**PEDIDO MÍNIMO R$50,00!**');
      resposta.push('**APENAS PEDIDO ANTECIPADO, NÃO ATENDEMOS A PRONTA ENTREGA!**');
      resposta.push('**HORÁRIO DE ENTREGA VARIÁVEL!**');
      resposta.push('**ENTREGA GRÁTIS**');
  
      return msg.reply(resposta.join('\n'));
    } catch (err) {
      console.error('Erro ao gerar lista:', err);
      return msg.reply('⚠️ Erro ao gerar a lista de produtos.');
    }
  }
  

    // pedidos em andamento
    if (textoNormalizado === 'pedidos') {
      try {
        const [pedidos] = await db.query(
          "SELECT id, cliente_numero, itens, status FROM vendas WHERE status IN ('novo','embalado')"
        );
        if (!pedidos.length) return msg.reply('📭 Nenhum pedido em andamento.');
        for (const p of pedidos) {
          await msg.reply(
            `🧾 Pedido ${p.id}\n📞 Cliente: ${p.cliente_numero}\n🛍️ Itens: ${p.itens}\n📌 Status: ${p.status}`
          );
        }
        return;
      } catch (err) {
        console.error('Erro ao listar pedidos:', err);
        return msg.reply('⚠️ Erro ao listar pedidos.');
      }
    }

    
    // Info de produto
    if (textoNormalizado.startsWith('info ')) {
      const termo = texto.substring(5).trim().toLowerCase();
      try {
        const [produtos] = await db.query(
          'SELECT * FROM estoque WHERE LOWER(nome) LIKE ?',
          [`%${termo}%`]
        );
        if (!produtos.length) return msg.reply('❌ Produto não encontrado.');
        const item = produtos[0];
        let info = ` *${item.nome}*\n📏 ${item.quantidade} ${item.medida}` +
                   `\n🗓️ Recebido em: ${moment(item.data_recebimento).format('DD/MM/YYYY')}`;
        if (item.info_extra) info += `\n📝 ${item.info_extra}`;
        await msg.reply(info);
        if (item.imagem) {
          return client.sendMessage(
            msg.from,
            Buffer.from(item.imagem, 'base64'),
            { caption: '📷 Produto' }
          );
        }
        return;
      } catch (err) {
        console.error('Erro ao buscar info:', err);
        return msg.reply('⚠️ Erro ao obter informações do produto.');
      }
    }
    // Iniciar pedido via contato (vCard)
    if (['vcard', 'multi_vcard'].includes(msg.type)) {
      const waidMatch = msg.body.match(/waid=(\d+)/);
      let numeroBruto = waidMatch ? waidMatch[1] : null;
      if (!numeroBruto && msg.vCardFormattedName) {
        numeroBruto = msg.vCardFormattedName.replace(/\D/g, '');
      }
      if (!numeroBruto) return msg.reply('❌ Não consegui ler o número do contato.');
      const numeroCompleto = numeroBruto.startsWith('55') ? numeroBruto : '55' + numeroBruto;
      const numeroFormatado = numeroCompleto + '@c.us';
      sessao.pedido = { cliente: numeroFormatado, itens: [], etapa: 'itens' };
      return msg.reply(`📲 Cliente definido como *${numeroCompleto}*.` +
                       `\nAgora envie o produto (nome ou ID).`);
    }
    // Iniciar pedido via número digitado
    if (/^[0-9]{8,13}$/.test(textoNormalizado)) {
      const numeric = textoNormalizado;
      const numeroCompleto = numeric.startsWith('55') ? numeric : '55' + numeric;
      const numeroFormatado = numeroCompleto + '@c.us';
      sessao.pedido = { cliente: numeroFormatado, itens: [], etapa: 'itens' };
      return msg.reply(`📲 Cliente definido como *${numeroCompleto}*.` +
                       `\nAgora envie o produto (nome ou ID).`);
    }
    return msg.reply(
      '🛍️ Setor de VENDAS ativo. Use "laranja", "lista", "info [produto]" ' +
      'ou envie um contato/número para iniciar um pedido.'
    );
  }
  // 2) Pedido em andamento
  // Etapa de itens
  if (sessao.pedido.etapa === 'itens') {
    // Finalizar etapa de itens
    if (textoNormalizado === 'finalizar') {
      if (!sessao.pedido.itens.length) {
        return msg.reply('❌ Você ainda não adicionou nenhum item.');
      }
      // Calcula valorTotal
      let valorTotal = 0;
      for (const desc of sessao.pedido.itens) {
        const [nomeItem, quantUn] = desc.split(' - ');
        const quantidade = parseFloat(quantUn);
        const [rows] = await db.query(
          'SELECT valor_unitario FROM estoque WHERE LOWER(nome) = ?',
          [nomeItem.toLowerCase()]
        );
        if (rows.length) valorTotal += quantidade * parseFloat(rows[0].valor_unitario);
      }
      sessao.pedido.valorTotal = valorTotal;
      sessao.pedido.etapa = 'pagamento';
      const resumo = sessao.pedido.itens.map(i => `• ${i}`).join('\n');
      return msg.reply(`✅ Itens registrados:\n${resumo}\n\n💳 Como será o pagamento? (Pix, Dinheiro ou ambos)`);
    }
    // Seleciona produto para adicionar
    if (!sessao.pedido.awaitingQuantidade) {
      const termo = texto.trim();
      const isId = /^[0-9]+$/.test(termo);
      const query = isId
        ? 'SELECT id,nome FROM estoque WHERE id = ?'
        : 'SELECT id,nome FROM estoque WHERE LOWER(nome) = ?';
      const [rows] = await db.query(query, [isId ? termo : termo.toLowerCase()]);
      if (!rows.length) {
        return msg.reply(`❌ Produto "${termo}" não encontrado no estoque.`);
      }
      sessao.pedido.produtoTemp = { id: rows[0].id, nome: rows[0].nome };
      sessao.pedido.awaitingQuantidade = true;
      return msg.reply(`📦 Produto: *${rows[0].nome}*\nInforme a quantidade e unidade (ex: 2 kg, 5 un):`);
    }
    // Recebe quantidade + unidade para o produto selecionado
    if (sessao.pedido.awaitingQuantidade) {
      const match = texto.trim().toLowerCase().match(/^([\d.,]+)\s*(kg|g|un|l|ml)$/);
      if (!match) {
        return msg.reply('⚠️ Formato inválido. Use algo como: `2 kg`, `5 un`, `1.5 l`');
      }
      const quantidade = parseFloat(match[1].replace(',', '.'));
      const unidade = match[2];
      const descricao = `${sessao.pedido.produtoTemp.nome} - ${quantidade} ${unidade}`;
      sessao.pedido.itens.push(descricao);
      delete sessao.pedido.produtoTemp;
      delete sessao.pedido.awaitingQuantidade;
      return msg.reply(`➕ Adicionado: ${descricao}\nDigite mais itens ou "finalizar".`);
    }
  }
  // Etapa de pagamento
  if (sessao.pedido.etapa === 'pagamento') {
    if (['pix','dinheiro','pix e dinheiro','dinheiro e pix'].includes(textoNormalizado)) {
      sessao.pedido.forma = textoNormalizado;
      if (textoNormalizado === 'pix') {
        sessao.pedido.etapa = 'pix';
        return msg.reply('📎 Envie o comprovante em imagem.');
      }
      if (textoNormalizado === 'dinheiro') {
        sessao.pedido.etapa = 'dinheiro';
      }
      // pagamento misto
      sessao.pedido.etapa = 'pix_misto';
      return msg.reply('📎 Envie o comprovante do valor pago em PIX.');
    }
    return msg.reply('💳 Forma de pagamento inválida. Use "pix", "dinheiro" ou "pix e dinheiro".');
  }
  // PIX comprovante (puro)
  if (sessao.pedido.etapa === 'pix' && msg.hasMedia) {
    const media = await msg.downloadMedia();
    sessao.pedido.comprovante = Buffer.from(media.data, 'base64');
    sessao.pedido.etapa = 'endereco';
    return msg.reply('📍 Informe o endereço: rua, número, bairro.');
  }
  // PIX misto - parte PIX
  if (sessao.pedido.etapa === 'pix_misto' && msg.hasMedia) {
    const media = await msg.downloadMedia();
    sessao.pedido.comprovante = Buffer.from(media.data, 'base64');
    sessao.pedido.etapa = 'dinheiro_misto';
    return msg.reply('💰 Agora informe o valor pago em dinheiro.');
  }
  // Dinheiro puro ou misto parte dinheiro
  if ((sessao.pedido.etapa === 'dinheiro' || sessao.pedido.etapa === 'dinheiro_misto') && !isNaN(parseFloat(texto))) {
    sessao.pedido.valor = parseFloat(texto.replace(',', '.'));
    sessao.pedido.etapa = 'endereco';
    return msg.reply('📍 Informe o endereço: rua, número, bairro.');
  }
  // Endereço e salvamento final
  if (sessao.pedido.etapa === 'endereco') {
    sessao.pedido.endereco = texto;
    const valorFinal = sessao.pedido.valorTotal || sessao.pedido.valor || 0;
const itensJson = JSON.stringify(sessao.pedido.itens);
const vendedor = msg.from.replace('@c.us', '');
try {
  // Inserir na tabela de vendas
  // Buscar o ID do vendedor na tabela usuarios com base no número
const [vendedorRows] = await db.query(
  'SELECT id FROM usuarios WHERE id = ? LIMIT 1',
  [vendedor] // ou outro campo que represente o número do vendedor
);

const vendedorId = vendedorRows.length ? vendedorRows[0].id : null;

// Inserir na tabela de vendas com o vendedor_id
const [result] = await db.query(
  `INSERT INTO vendas 
    (cliente_numero, itens, forma_pagamento, comprovante, valor_total, endereco, recebido, status, vendedor_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [
    sessao.pedido.cliente,
    itensJson,
    sessao.pedido.forma,
    sessao.pedido.comprovante || null,
    valorFinal,
    sessao.pedido.endereco,
    false,
    'novo',
    vendedorId
  ]
);

// Capturar o ID da venda inserida
const vendaId = result.insertId;

// Inserir na tabela de pedidos_diarios com o venda_id correto
await db.query(
  'INSERT INTO pedidos_diarios (cliente_numero, itens, endereco, recebido, status, venda_id) VALUES (?, ?, ?, ?, ?, ?)',
  [
    sessao.pedido.cliente,
    itensJson,
    sessao.pedido.endereco,
    false,
    'novo',
    vendaId
  ]

  );  
} catch (err) {
  console.error('Erro ao salvar pedido:', err);
  return msg.reply('⚠️ Erro ao registrar o pedido. Tente novamente mais tarde.');
}

    delete sessao.pedido;
    return msg.reply('🧾 Pedido registrado com sucesso!');
  }

  // Default fallback
  return msg.reply(
    '🛍️ Setor de VENDAS ativo. Use "lista", "info [produto]" ' +
    'ou envie mais comandos conforme instruções.'
  );
};
