// 📁 setores/estoque.js
module.exports = async function tratarEstoque(texto, msg, sessao, db, client) {
    if (!sessao.subetapa) sessao.subetapa = null;
  
    if (texto.toLowerCase().startsWith('adicionar ')) {
      const nomeProduto = texto.substring(10).trim();
      sessao.produto = nomeProduto;
  
      const [existe] = await db.query('SELECT * FROM estoque WHERE nome = ?', [nomeProduto]);
      if (existe.length) {
        sessao.subetapa = 'confirmarAtualizacao';
        return msg.reply('📌 Este produto já existe. Deseja atualizar o estoque? Responda com "sim" ou "não".');
      } else {
        sessao.subetapa = 'coletarDados';
        return msg.reply('📥 Informe o estoque inicial, medida (ex: kg, un), data de recebimento e info extra, separados por vírgula.');
      }
    }
  
    if (sessao.subetapa === 'confirmarAtualizacao') {
      if (texto.toLowerCase() === 'sim') {
        sessao.subetapa = 'coletarDados';
        return msg.reply('📥 Ok! Informe os novos dados: estoque inicial, medida, data de recebimento e info extra (separados por vírgula).');
      } else if (texto.toLowerCase() === 'não') {
        delete sessao.produto;
        sessao.subetapa = null;
        return msg.reply('❌ Operação cancelada.');
      }
    }
  
    if (sessao.subetapa === 'coletarDados' && texto.includes(',')) {
      const [estoqueInicial, medida, dataReceb, infoExtra] = texto.split(',').map(x => x.trim());
      const produto = sessao.produto;
  
      const [existe] = await db.query('SELECT * FROM estoque WHERE nome = ?', [produto]);
      if (existe.length) {
        await db.query('UPDATE estoque SET quantidade = ?, medida = ?, data_recebimento = ?, info_extra = ? WHERE nome = ?', [
          estoqueInicial, medida, dataReceb, infoExtra, produto
        ]);
      } else {
        await db.query('INSERT INTO estoque (nome, quantidade, medida, data_recebimento, info_extra) VALUES (?, ?, ?, ?, ?)', [
          produto, estoqueInicial, medida, dataReceb, infoExtra
        ]);
      }
  
      await db.query('INSERT INTO compras (nome_produto, quantidade, medida, data_compra) VALUES (?, ?, ?, ?)', [
        produto, estoqueInicial, medida, dataReceb
      ]);
  
      sessao.subetapa = 'aguardandoFoto';
      return msg.reply('✅ Produto salvo com sucesso! Agora envie a foto do produto.');
    }
  
    if (sessao.subetapa === 'aguardandoFoto' && msg.hasMedia) {
      const media = await msg.downloadMedia();
      if (!media) return msg.reply('⚠️ Não consegui baixar a mídia. Tente novamente.');
  
      await db.query('UPDATE estoque SET imagem = ? WHERE nome = ?', [media.data, sessao.produto]);
  
      delete sessao.produto;
      sessao.subetapa = null;
      return msg.reply('🖼️ Foto salva com sucesso! Produto registrado no estoque.');
    }
  
    return msg.reply('📦 Estoque ativo. Envie "adicionar nome" para cadastrar um novo produto.');
  };
  