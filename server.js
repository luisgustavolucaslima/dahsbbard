const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');
const app = express();
const port = 3000;
const usuariosPermitidos = ['usuario1', 'usuario2'];
const cors = require('cors');
app.use(cors());
const bcrypt = require('bcrypt');

const db = mysql.createPool({
  host: '127.0.0.1',
  user: 'root',
  password: '',
  database: 'iceclubestoque'
});

app.use(express.static('.'));
app.use(express.json());

// Rota para listar pedidos diários
app.get('/pedidos_diarios', async (req, res) => {
  try {
    const [pedidos] = await db.query(`
              SELECT 
          pd.id, 
          pd.cliente_numero, 
          pd.status, 
          pd.valido, 
          pd.data_hora, 
          pd.numero_diario, 
          pd.data, 
          pd.recebido, 
          pd.venda_id,
          GROUP_CONCAT(CONCAT(pi.quantidade, ' x ', e.nome)) as produtos,
          v.valor_total,
          ROW_NUMBER() OVER (ORDER BY pd.data_hora ASC) as pedido_numero
        FROM pedidos_diarios pd
        LEFT JOIN vendas v ON pd.venda_id = v.id
        LEFT JOIN pedido_itens pi ON pi.pedido_id = pd.id
        LEFT JOIN estoque e ON pi.produto_id = e.id
        WHERE DATE(pd.data) = CURDATE()
        GROUP BY pd.id
        ORDER BY pd.data_hora ASC
    `);
    res.json(pedidos);
  } catch (err) {
    console.error("Erro ao buscar pedidos:", err);
    res.status(500).json({ erro: 'Erro ao buscar pedidos' });
  }
});

app.get('/api/produtos', async (req, res) => {
  try {
    const [produtos] = await db.query('SELECT id, nome, valor_unitario FROM estoque');
    res.json(produtos);
  } catch (e) {
    console.error('Erro ao buscar produtos:', e);
    res.status(500).json({ erro: 'Erro ao carregar produtos' });
  }
});


// Rota para alterar status do pedido
app.post('/alterar_status', async (req, res) => {
  const { id, statusAtual } = req.body;
  const validStatuses = ['novo', 'embalado', 'entrega', 'rua', 'finalizado', 'falha', 'incorreto'];
  const transicoes = {
    novo: 'embalado',
    embalado: 'entrega',
    entrega: 'rua',
    rua: 'finalizado'
  };

  if (!id || !statusAtual || !validStatuses.includes(statusAtual)) {
    return res.status(400).json({ erro: 'ID ou status atual inválido' });
  }

  const novoStatus = transicoes[statusAtual] || statusAtual;

  try {
    const [result] = await db.query(
      "UPDATE pedidos_diarios SET status = ? WHERE id = ?",
      [novoStatus, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ erro: 'Pedido não encontrado' });
    }

    await db.query(
      "INSERT INTO log_alteracoes (tabela, registro_id, acao, usuario_id, detalhes) VALUES (?, ?, ?, ?, ?)",
      ['pedidos_diarios', id, 'UPDATE', null, `Status alterado de ${statusAtual} para ${novoStatus}`]
    );

    res.status(200).json({ mensagem: `Status alterado para ${novoStatus}` });
  } catch (err) {
    console.error("Erro ao alterar status:", err);
    res.status(500).json({ erro: 'Erro ao alterar status do pedido.' });
  }
});

// Corrigindo /enviar_para_entrega
app.post('/enviar_para_entrega', async (req, res) => {
  try {
    const { rota } = req.body;
    const [pedidos] = await db.query(`
      SELECT 
        pd.id, pd.cliente_numero, pd.data, pd.recebido,
        GROUP_CONCAT(CONCAT(pi.quantidade, ' x ', e.nome)) as itens
      FROM pedidos_diarios pd
      LEFT JOIN pedido_itens pi ON pi.pedido_id = pd.id
      LEFT JOIN estoque e ON pi.produto_id = e.id
      WHERE pd.status = 'entrega' AND DATE(pd.data) = CURDATE()
      GROUP BY pd.id
    `);
    const quantidade_pedidos = pedidos.length;
    for (const pedido of pedidos) {
      await db.query(`
        INSERT INTO entregas
          (pedido_id, cliente_numero, itens, recebido, rota, data_pedido)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        pedido.id,
        pedido.cliente_numero,
        pedido.itens || '',
        pedido.recebido,
        rota,
        pedido.data
      ]);
    }
    res.status(200).json({ mensagem: `Pedidos enviados para rota ${rota}. Total de pedidos: ${quantidade_pedidos}` });
  } catch (erro) {
    console.error('Erro em /enviar_para_entrega:', erro);
    res.status(500).json({ mensagem: 'Erro ao processar os pedidos para entrega.', erro: erro.message });
  }
});



app.post('/mover', async (req, res) => {
  const { id, status } = req.body;
  try {
    await db.query("UPDATE pedidos_diarios SET status = ? WHERE id = ?", [status, id]);
    res.sendStatus(200);
  } catch (err) {
    console.error("Erro ao mover pedido:", err);
    res.status(500).send("Erro interno ao mover pedido.");
  }
});

app.post('/valido', async (req, res) => {
  const { id, valido } = req.body;

  // Validação inicial fora do try/catch
  if (!id || isNaN(id)) {
    return res.status(400).json({ erro: 'ID do pedido inválido' });
  }

  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    if (valido == 0) {
      await conn.query("UPDATE pedidos_diarios SET valido = ?, status = 'finalizado' WHERE id = ?", [valido, id]);
      await conn.commit();
      return res.sendStatus(200);
    }

    // Verificar se o pedido existe
    const [pedido] = await conn.query("SELECT id FROM pedidos_diarios WHERE id = ?", [id]);
    if (pedido.length === 0) {
      await conn.rollback();
      return res.status(404).json({ erro: 'Pedido não encontrado' });
    }

    // Verificar estoque para valido == 1
    const [itens] = await conn.query(`
      SELECT pi.produto_id, pi.quantidade, e.quantidade AS em_estoque, e.nome
      FROM pedido_itens pi
      JOIN estoque e ON pi.produto_id = e.id
      WHERE pi.pedido_id = ?
    `, [id]);

    // Verificar estoque suficiente
    for (const item of itens) {
      if (item.quantidade > item.em_estoque) {
        await conn.rollback();
        return res.status(400).json({ erro: `Estoque insuficiente para o produto ${item.nome} (ID: ${item.produto_id})` });
      }
    }

    // Atualizar apenas o pedido, sem mexer no estoque
    await conn.query(
      "UPDATE pedidos_diarios SET valido = ?, status = 'novo' WHERE id = ?",
      [valido, id]
    );

    await conn.commit();
    res.sendStatus(200);
  } catch (err) {
    if (conn) await conn.rollback();
    console.error("Erro ao atualizar validade do pedido:", err);
    res.status(500).json({ erro: `Erro interno ao atualizar validade: ${err.message}` });
  } finally {
    if (conn) conn.release();
  }
});
// Rota para listar pedidos elegíveis para devolução
app.get('/api/pedidos-devolucao', async (req, res) => {
  try {
    const { page = 1, limit = 10, data = null } = req.query;
    const offset = (page - 1) * limit;
    let query = `
      SELECT 
        pd.id,
        pd.cliente_numero,
        pd.status,
        pd.recebido,
        pd.data_hora AS data,
        v.valor_total
      FROM pedidos_diarios pd
      LEFT JOIN vendas v ON pd.venda_id = v.id
      WHERE pd.status IN ('incorreto', 'falha')
    `;
    const params = [];
    if (data) {
      query += ' AND DATE(pd.data_hora) = ?';
      params.push(data);
    }
    query += ' ORDER BY pd.data_hora DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const [pedidos] = await db.query(query, params);

    if (pedidos.length === 0) {
      return res.status(200).json({ mensagem: 'Não existem devoluções disponíveis no momento.' });
    }

    const [[{ total }]] = await db.query(`
      SELECT COUNT(*) as total
      FROM pedidos_diarios pd
      WHERE pd.status IN ('incorreto', 'falha')
      ${data ? 'AND DATE(pd.data_hora) = ?' : ''}
    `, data ? [data] : []);

    res.status(200).json({
      pedidos,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('Erro ao buscar pedidos para devolução:', err);
    res.status(500).json({ erro: 'Erro ao buscar pedidos para devolução' });
  }
});

app.post('/login', async (req, res) => {
  const { usuario, senha } = req.body;
  const [usuarios] = await db.query("SELECT * FROM usuarios_web WHERE usuario = ?", [usuario]);
  if (usuarios.length && await bcrypt.compare(senha, usuarios[0].senha)) {
    return res.json({ usuario: usuarios[0].usuario, permissao: usuarios[0].permissao });
  }
  res.status(401).send("Usuário ou senha inválidos");
});

app.get('/comprovante/:id', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT comprovante FROM vendas WHERE id = ?', [req.params.id]);
    if (rows.length > 0 && rows[0].comprovante) {
      const base64 = Buffer.from(rows[0].comprovante).toString('base64');
      res.json({ image: `data:image/png;base64,${base64}` });
    } else {
      res.status(404).send('Comprovante não encontrado');
    }
  } catch (err) {
    console.error('Erro ao buscar comprovante:', err);
    res.status(500).send('Erro ao buscar comprovante');
  }
});


// Rota para listar categorias do estoque
app.get('/api/estoque/categorias', async (req, res) => {
  try {
    const [categorias] = await db.query('SELECT id, nome FROM categorias_estoque ORDER BY nome');
    if (categorias.length === 0) {
      return res.status(404).json({ error: 'Nenhuma categoria encontrada' });
    }
    const formattedCategorias = categorias.map(cat => ({
      id: cat.id,
      nome: cat.nome.charAt(0).toUpperCase() + cat.nome.slice(1)
    }));
    res.json(formattedCategorias);
  } catch (error) {
    console.error('Erro ao buscar categorias:', error);
    res.status(500).json({ error: 'Erro ao buscar categorias' });
  }
});

app.get('/api/vendas-por-cliente', async (req, res) => {
  try {
    const busca = req.query.busca || '';
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const params = busca ? [`%${busca}%`] : [];
    const query = `
      SELECT 
        cliente_numero,
        COUNT(*) AS total_vendas,
        SUM(valor_total) AS valor_total,
        MAX(data) AS ultima_compra
      FROM vendas
      ${busca ? 'WHERE cliente_numero LIKE ?' : ''}
      GROUP BY cliente_numero
      ORDER BY ultima_compra DESC
      LIMIT ? OFFSET ?
    `;
    const countQuery = `
      SELECT COUNT(DISTINCT cliente_numero) as total
      FROM vendas
      ${busca ? 'WHERE cliente_numero LIKE ?' : ''}
    `;
    params.push(limit, offset);
    const [clientes] = await db.query(query, params);
    const [[{ total }]] = await db.query(countQuery, busca ? [`%${busca}%`] : []);
    res.json({
      clientes,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('Erro ao buscar vendas por cliente:', err);
    res.status(500).json({ erro: 'Erro ao buscar vendas por cliente' });
  }
});

app.get('/api/estoque', async (req, res) => {
  try {
    const { page = 1, limit = 10, nome, categoria, estoque_baixo } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    const countParams = [];
    let whereClauses = [];
    if (nome) {
      whereClauses.push('nome LIKE ?');
      params.push(`%${nome}%`);
      countParams.push(`%${nome}%`);
    }
    if (categoria) {
      whereClauses.push('categoria = ?');
      params.push(categoria);
      countParams.push(categoria);
    }
    if (estoque_baixo === 'baixo') {
      whereClauses.push('quantidade < 10');
      countParams.push('quantidade < 10');
    }
    const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const query = `
      SELECT 
        id,
        nome,
        quantidade,
        valor_unitario,
        categoria,
        ultima_atualizacao
      FROM estoque
      ${where}
      ORDER BY ultima_atualizacao DESC
      LIMIT ? OFFSET ?
    `;
    const countQuery = `SELECT COUNT(*) as total FROM estoque ${where}`;
    params.push(parseInt(limit), parseInt(offset));
    const [itens] = await db.query(query, params);
    const [[{ total }]] = await db.query(countQuery, countParams);
    res.json({
      itens,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('Erro ao buscar estoque:', err);
    res.status(500).json({ erro: 'Erro ao buscar estoque' });
  }
});

app.post('/api/estoque', async (req, res) => {
  try {
    const { nome, quantidade, medida, descricao, preco, categoria } = req.body;
    if (!nome || quantidade === undefined || preco === undefined || !categoria || !descricao || !medida) {
      return res.status(400).json({ erro: 'Todos os campos são obrigatórios' });
    }
    const [result] = await db.query(
      'INSERT INTO estoque (nome, quantidade, medida, info_extra, valor_unitario, categoria, ultima_atualizacao) VALUES (?, ?, ?, ?, ?, ?, NOW())',
      [nome, quantidade, medida, descricao, preco, categoria]
    );
    res.status(201).json({ id: result.insertId, mensagem: 'Item adicionado com sucesso' });
  } catch (err) {
    console.error('Erro ao adicionar item:', err);
    res.status(500).json({ erro: 'Erro ao adicionar item' });
  }
});
app.post('/api/estoque/entrada', async (req, res) => {
  const { id, quantidade, descricao } = req.body;
  if (!id || !quantidade) return res.status(400).json({ erro: 'Dados inválidos' });

  try {
    await db.query('UPDATE estoque SET quantidade = quantidade + ? WHERE id = ?', [quantidade, id]);
    await db.query('INSERT INTO lancamentos (descricao, categoria, tipo, data_lancamento) VALUES (?, "estoque", "entrada", NOW())', [descricao || `Entrada de estoque ID ${id}`]);

    res.json({ mensagem: 'Estoque atualizado com sucesso' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao atualizar estoque' });
  }
});
app.post('/api/estoque/saida', async (req, res) => {
  const { id, quantidade, descricao } = req.body;
  if (!id || !quantidade || quantidade <= 0) {
    return res.status(400).json({ erro: 'Dados inválidos' });
  }

  try {
    const [[item]] = await db.query('SELECT quantidade, nome FROM estoque WHERE id = ?', [id]);
    if (!item) return res.status(404).json({ erro: 'Item não encontrado' });

    if (item.quantidade < quantidade) {
      return res.status(400).json({ erro: 'Quantidade insuficiente no estoque' });
    }

    await db.query('UPDATE estoque SET quantidade = quantidade - ? WHERE id = ?', [quantidade, id]);
    await db.query('INSERT INTO lancamentos (descricao, categoria, tipo, data_lancamento) VALUES (?, "estoque", "saida", NOW())',
      [descricao || `Baixa de ${quantidade} do item ${item.nome}`]
    );

    res.json({ mensagem: 'Baixa de estoque realizada com sucesso' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao realizar baixa' });
  }
});

app.get('/api/lancamentos', async (req, res) => {
  try {
    const { page = 1, limit = 10, descricao, categoria, tipo, sortBy = 'data_lancamento', sortOrder = 'DESC' } = req.query;
    const offset = (page - 1) * limit;

    const validColumns = ['id', 'descricao', 'categoria', 'tipo', 'data_lancamento'];
    const column = validColumns.includes(sortBy) ? sortBy : 'data_lancamento';
    const order = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    let query = 'SELECT * FROM lancamentos';
    let countQuery = 'SELECT COUNT(*) as total FROM lancamentos';
    const params = [];
    const countParams = [];
    const conditions = [];

    if (descricao) {
      conditions.push('descricao LIKE ?');
      params.push(`%${descricao}%`);
      countParams.push(`%${descricao}%`);
    }
    if (categoria) {
      conditions.push('categoria = ?');
      params.push(categoria);
      countParams.push(categoria);
    }
    if (tipo) {
      conditions.push('tipo = ?');
      params.push(tipo);
      countParams.push(tipo);
    }

    if (conditions.length > 0) {
      const whereClause = ' WHERE ' + conditions.join(' AND ');
      query += whereClause;
      countQuery += whereClause;
    }

    query += ` ORDER BY ${column} ${order} LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));

    const [dados] = await db.query(query, params);
    const [[{ total }]] = await db.query(countQuery, countParams);

    res.json({
      lancamentos: dados,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Erro ao buscar lançamentos:', error);
    res.status(500).json({ erro: 'Erro ao buscar lançamentos' });
  }
});
// Rota para adicionar lançamento
app.post('/api/lancamentos', async (req, res) => {
  const { descricao, categoria, data_lancamento, tipo, pedido_id, valor } = req.body;

  // Validação básica
  if (!descricao || !data_lancamento) {
    return res.status(400).json({ erro: 'Descrição e data de lançamento são obrigatórios.' });
  }

  // Se for uma devolução (identificada por pedido_id), forçar tipo e categoria
  const finalTipo = pedido_id ? 'devolução' : (tipo || null);
  const finalCategoria = pedido_id ? 'Outros' : (categoria || null);
  const finalDescricao = pedido_id ? `Devolução - ${descricao}` : descricao;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Inserir o lançamento
    const [result] = await conn.query(
      'INSERT INTO lancamentos (descricao, categoria, data_lancamento, tipo, pedido_id, valor) VALUES (?, ?, ?, ?, ?, ?)',
      [finalDescricao, finalCategoria, data_lancamento, finalTipo, pedido_id || null, valor || null]
    );

    // Se for uma devolução, atualizar status e estoque
    if (pedido_id) {
      // Verificar se o pedido existe
      const [pedido] = await conn.query('SELECT id, status FROM pedidos_diarios WHERE id = ?', [pedido_id]);
      if (pedido.length === 0) {
        throw new Error('Pedido não encontrado.');
      }

      // Atualizar o status do pedido para "devolvido"
      await conn.query('UPDATE pedidos_diarios SET status = ? WHERE id = ?', ['devolvido', pedido_id]);

      // Obter os itens do pedido
      const [itens] = await conn.query(
        'SELECT pi.produto_id, pi.quantidade FROM pedido_itens pi WHERE pi.pedido_id = ?',
        [pedido_id]
      );

      if (itens.length === 0) {
        throw new Error('Nenhum item encontrado para o pedido.');
      }

      // Atualizar o estoque para cada item
      for (const item of itens) {
        const [estoque] = await conn.query('SELECT id, quantidade FROM estoque WHERE id = ?', [item.produto_id]);
        if (estoque.length === 0) {
          throw new Error(`Produto com ID ${item.produto_id} não encontrado no estoque.`);
        }

        await conn.query(
          'UPDATE estoque SET quantidade = quantidade + ? WHERE id = ?',
          [item.quantidade, item.produto_id]
        );

        // Opcional: Registrar log da movimentação de estoque
        await conn.query(
          'INSERT INTO lancamentos (descricao, categoria, tipo, data_lancamento, pedido_id, valor) VALUES (?, ?, ?, ?, ?, ?)',
          [
            `Retorno ao estoque: ${item.quantidade} unidades do produto ${item.produto_id}`,
            'Estoque',
            'entrada',
            data_lancamento,
            pedido_id,
            null
          ]
        );
      }
    }

    await conn.commit();
    res.json({ mensagem: 'Lançamento cadastrado com sucesso.', id: result.insertId });
  } catch (error) {
    await conn.rollback();
    console.error('Erro ao adicionar lançamento:', error);
    res.status(500).json({ erro: `Erro ao adicionar lançamento: ${error.message}` });
  } finally {
    conn.release();
  }
});

app.get('/api/entregadores-disponiveis', async (req, res) => {
  try {
    const [entregadores] = await db.query(`
      SELECT id, nome FROM usuarios WHERE cargo = 'entregador'
    `);
    res.json(entregadores);
  } catch (err) {
    console.error('Erro ao buscar entregadores:', err);
    res.status(500).json({ erro: 'Erro ao buscar entregadores' });
  }
});


app.post('/api/atribuir-entregas', async (req, res) => {
  const { entregador_id, pedidos } = req.body;
  const minimo = 1;

  if (!entregador_id || !Array.isArray(pedidos) || pedidos.length < minimo) {
    return res.status(400).json({ erro: `Selecione no mínimo ${minimo} pedidos e um entregador.` });
  }

  try {
    for (const pedido_id of pedidos) {
      await db.query(`
        INSERT INTO entregas (pedido_id, cliente_numero, recebido, rota, entregador_id, data_pedido, status)
        SELECT 
          pd.id, pd.cliente_numero, pd.recebido, 1, ?, pd.data, 'rua'
        FROM pedidos_diarios pd
        WHERE pd.id = ?
      `, [entregador_id, pedido_id]);

      await db.query(`UPDATE pedidos_diarios SET status = 'rua' WHERE id = ?`, [pedido_id]);
    }

    res.json({ mensagem: `Entregas atribuídas com sucesso para entregador ${entregador_id}` });
  } catch (err) {
    console.error('Erro ao atribuir entregas:', err);
    res.status(500).json({ erro: 'Erro ao atribuir entregas' });
  }
});


// Rota para editar lançamento
app.put('/api/lancamentos/:id', async (req, res) => {
  const { id } = req.params;
  const { descricao, categoria, data_lancamento, tipo } = req.body;
  if (!descricao || !data_lancamento) {
    return res.status(400).json({ erro: 'Descrição e data de lançamento são obrigatórios.' });
  }
  try {
    const [result] = await db.query(
      'UPDATE lancamentos SET descricao = ?, categoria = ?, data_lancamento = ?, tipo = ? WHERE id = ?',
      [descricao, categoria, data_lancamento, tipo, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ erro: 'Lançamento não encontrado.' });
    }
    res.json({ mensagem: 'Lançamento atualizado com sucesso.' });
  } catch (error) {
    console.error('Erro ao atualizar lançamento:', error);
    res.status(500).json({ erro: 'Erro ao atualizar lançamento' });
  }
});

// Rota para deletar lançamento
app.delete('/api/lancamentos/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await db.query('DELETE FROM lancamentos WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ erro: 'Lançamento não encontrado.' });
    }
    res.json({ mensagem: 'Lançamento deletado com sucesso.' });
  } catch (error) {
    console.error('Erro ao deletar lançamento:', error);
    res.status(500).json({ erro: 'Erro ao deletar lançamento' });
  }
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const [[vendasInfo]] = await db.query(`
      SELECT 
        COUNT(*) AS totalVendas, 
        SUM(valor_total) AS totalReceita,
        AVG(valor_total) AS valorMedio
      FROM vendas
      WHERE DATE(data) = CURDATE() 
    `);
    const [[baixoEstoque]] = await db.query(`
      SELECT COUNT(*) AS baixoEstoque
      FROM estoque
      WHERE quantidade < 10
    `);
    const [topCompradores] = await db.query(`
      SELECT 
        cliente_numero,
        COUNT(*) AS total_compras,
        SUM(valor_total) AS valor_total,
        MAX(data) AS ultima_compra
      FROM vendas
      GROUP BY cliente_numero
      ORDER BY valor_total DESC
      LIMIT 5
    `);
    const [itensVendidos] = await db.query(`
      SELECT 
        e.id, e.nome, e.valor_unitario, e.categoria,
        SUM(pi.quantidade) AS quantidade_vendida,
        SUM(pi.quantidade * e.valor_unitario) AS receita_total
      FROM pedido_itens pi
      JOIN pedidos_diarios pd ON pi.pedido_id = pd.id
      JOIN estoque e ON pi.produto_id = e.id
      WHERE DATE(pd.data) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) 
      GROUP BY e.id, e.nome, e.valor_unitario, e.categoria
      ORDER BY quantidade_vendida DESC
      LIMIT 5
    `);
    const topProdutos = itensVendidos.map(item => ({
      id: item.id,
      nome: item.nome,
      categoria: item.categoria,
      quantidade_vendida: Number(item.quantidade_vendida),
      receita_total: Number(item.receita_total)
    }));
    const [vendasDiarias] = await db.query(`
      SELECT 
        DATE(data) AS data,
        SUM(valor_total) AS receita
      FROM vendas
      WHERE DATE(data) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) 
      GROUP BY DATE(data)
      ORDER BY data
    `);
    res.json({
      totalVendas: vendasInfo.totalVendas || 0,
      totalReceita: vendasInfo.totalReceita || 0,
      valorMedio: vendasInfo.valorMedio || 0,
      baixoEstoque: baixoEstoque.baixoEstoque || 0,
      topCompradores,
      topProdutos,
      vendasDiarias
    });
  } catch (err) {
    console.error('Erro ao buscar dados do dashboard:', err);
    res.status(500).json({ erro: 'Erro ao buscar dados do dashboard' });
  }
});

app.patch('/api/estoque/:id', async (req, res) => {
  try {
    const { id: currentId } = req.params;
    const { id: newId, nome, quantidade, preco, categoria } = req.body;
    if (!nome || quantidade === undefined || preco === undefined || !categoria) {
      return res.status(400).json({ erro: 'Nome, quantidade, preço e categoria são obrigatórios' });
    }
    if (newId && newId !== currentId) {
      const [existing] = await db.query('SELECT id FROM estoque WHERE id = ?', [newId]);
      if (existing.length > 0) {
        return res.status(400).json({ erro: 'Novo ID já está em uso' });
      }
    }
    const [result] = await db.query(
      'UPDATE estoque SET id = ?, nome = ?, quantidade = ?, valor_unitario = ?, categoria = ?, ultima_atualizacao = NOW() WHERE id = ?',
      [newId || currentId, nome, quantidade, preco, categoria, currentId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ erro: 'Item não encontrado' });
    }
    res.json({ mensagem: 'Item atualizado com sucesso' });
  } catch (err) {
    console.error('Erro ao atualizar item:', err);
    res.status(500).json({ erro: 'Erro ao atualizar item' });
  }
});

app.delete('/api/estoque/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await db.query('DELETE FROM estoque WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ erro: 'Item não encontrado' });
    }
    res.json({ mensagem: 'Item deletado com sucesso' });
  } catch (err) {
    console.error('Erro ao deletar item:', err);
    res.status(500).json({ erro: 'Erro ao deletar item' });
  }
});

app.get('/entregas', async (req, res) => {
  try {
    const [dados] = await db.query(`
      SELECT entregador_id, quantidade_pedidos, hora_inicio, hora_fim, tempo_medio
      FROM entregas
      ORDER BY hora_fim DESC
      LIMIT 100
    `);
    res.json(dados);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao buscar entregas' });
  }
});

app.get('/api/categorias', async (req, res) => {
  try {
    const [result] = await db.query("SHOW COLUMNS FROM estoque LIKE 'categoria'");
    if (!result.length) {
      return res.status(404).json({ error: 'Coluna categoria não encontrada' });
    }
    const enumValues = result[0].Type.match(/enum\((.*)\)/)[1]
      .split(',')
      .map(value => value.replace(/'/g, ''));

    const categorias = enumValues.map((cat) => ({
      id: cat,
      nome: cat.charAt(0).toUpperCase() + cat.slice(1)
    }));

    res.json(categorias);
  } catch (error) {
    console.error('Erro ao buscar categorias:', error);
    res.status(500).json({ error: 'Erro ao buscar categorias' });
  }
});


app.post('/api/categorias', async (req, res) => {
  const { novaCategoria } = req.body;
  if (!novaCategoria) {
    return res.status(400).json({ error: 'Nome da categoria é obrigatório' });
  }

  try {
    const [result] = await db.query("SHOW COLUMNS FROM estoque LIKE 'categoria'");
    if (!result.length) {
      return res.status(404).json({ error: 'Coluna categoria não encontrada' });
    }

    const enumValues = result[0].Type.match(/enum\((.*)\)/)[1]
      .split(',')
      .map(value => value.replace(/'/g, ''));

    if (enumValues.includes(novaCategoria)) {
      return res.status(400).json({ error: 'Categoria já existe' });
    }

    const novosEnums = [...enumValues, novaCategoria].map(v => `'${v}'`).join(',');

    await db.query(`ALTER TABLE estoque MODIFY COLUMN categoria ENUM(${novosEnums}) NOT NULL`);

    res.json({ mensagem: 'Categoria adicionada com sucesso' });
  } catch (error) {
    console.error('Erro ao adicionar categoria:', error);
    res.status(500).json({ error: 'Erro ao adicionar categoria' });
  }
});


app.get('/api/resumo', async (req, res) => {
  try {
    const [[resumo]] = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM vendas WHERE DATE(data) = CURDATE()) AS totalVendas,
        (SELECT COUNT(*) FROM entregas WHERE status = 'finalizado' AND DATE(data_pedido) = CURDATE()) AS entregasRealizadas,
        (SELECT COUNT(*) FROM entregas WHERE status = 'falha' AND DATE(data_pedido) = CURDATE()) AS entregasFalha
    `);
    res.json({
      totalVendas: resumo.totalVendas || 0,
      entregasRealizadas: resumo.entregasRealizadas || 0,
      entregasFalha: resumo.entregasFalha || 0
    });
  } catch (err) {
    console.error('Erro ao buscar resumo:', err);
    res.status(500).json({ erro: 'Erro ao buscar resumo' });
  }
});

app.get('/api/entregas', async (req, res) => {
  try {
    const status = req.query.status || 'rua';
    const [entregas] = await db.query(`
      SELECT pedido_id, entregador_id, hora_inicio
      FROM entregas
      WHERE status = ?
      ORDER BY hora_inicio DESC
    `, [status]);
    res.json(entregas);
  } catch (err) {
    console.error('Erro ao buscar entregas:', err);
    res.status(500).json({ erro: 'Erro ao buscar entregas' });
  }
});



app.get('/api/entregadores', async (req, res) => {
  try {
    const [entregadores] = await db.query(`
      SELECT entregador, quantidade_pedidos, tempo_medio, km
      FROM entregador
      WHERE hora_fim IS NOT NULL
      ORDER BY hora_fim DESC
      LIMIT 100
    `);
    res.json(entregadores);
  } catch (err) {
    console.error('Erro ao buscar entregadores:', err);
    res.status(500).json({ erro: 'Erro ao buscar entregadores' });
  }
});

app.post('/api/atualizar_valor_recebido', async (req, res) => {
  const { id, valor_recebido } = req.body;

  if (!id || !valor_recebido || valor_recebido < 0) {
    return res.status(400).json({ erro: 'ID da venda e valor recebido são obrigatórios e devem ser válidos' });
  }

  try {
    const [result] = await db.query(
      'UPDATE vendas SET valor_pago = ? WHERE id = ?',
      [parseFloat(valor_recebido), id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ erro: 'Venda não encontrada' });
    }

    // Opcional: Registrar log da alteração
    await db.query(
      'INSERT INTO log_alteracoes (tabela, registro_id, acao, usuario_id, detalhes, data) VALUES (?, ?, ?, ?, ?, NOW())',
      ['vendas', id, 'UPDATE', null, `Valor recebido atualizado para R$ ${valor_recebido}`]
    );

    res.json({ mensagem: 'Valor recebido atualizado com sucesso' });
  } catch (err) {
    console.error('Erro ao atualizar valor recebido:', err);
    res.status(500).json({ erro: 'Erro ao atualizar valor recebido' });
  }
});

app.get('/api/vendas', async (req, res) => {
  try {
    const { cliente_numero, data_inicio, data_fim, status, page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    let whereClauses = [];

    if (cliente_numero) {
      whereClauses.push('v.cliente_numero LIKE ?');
      params.push(`%${cliente_numero}%`);
    }
    if (data_inicio) {
      whereClauses.push('DATE(v.data) >= ?');
      params.push(data_inicio);
    } else {
      whereClauses.push('DATE(v.data) = CURDATE()');
    }
    if (data_fim) {
      whereClauses.push('DATE(v.data) <= ?');
      params.push(data_fim);
    }
    if (status) {
      whereClauses.push('v.status = ?');
      params.push(status);
    }

    const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    
    const query = `
      SELECT 
        v.id,
        COALESCE(v.cliente_numero, '') AS cliente_numero,
        COALESCE(v.valor_total, 0) AS valor_total,
        COALESCE(v.forma_pagamento, 'pix') AS forma_pagamento,
        COALESCE(v.data, NOW()) AS data,
        COALESCE(v.status, 'novo') AS status,
        v.comprovante IS NOT NULL AS tem_comprovante,
        GROUP_CONCAT(CONCAT(pi.quantidade, ' x ', e.nome)) AS produtos,
        COALESCE(e2.observacoes, '') AS motivo_falha,
        COALESCE(e2.endereco, '') AS endereco
      FROM vendas v
      LEFT JOIN pedidos_diarios pd ON pd.venda_id = v.id
      LEFT JOIN pedido_itens pi ON pi.pedido_id = pd.id
      LEFT JOIN estoque e ON pi.produto_id = e.id
      LEFT JOIN entregas e2 ON e2.pedido_id = pd.id
      ${where}
      GROUP BY v.id
      ORDER BY v.data DESC
      LIMIT ? OFFSET ?
    `;
    
    const countQuery = `
      SELECT COUNT(*) as total
      FROM vendas v
      LEFT JOIN pedidos_diarios pd ON pd.venda_id = v.id
      ${where}
    `;
    
    params.push(parseInt(limit), parseInt(offset));
    
    const [vendas] = await db.query(query, params);
    const [[{ total }]] = await db.query(countQuery, params.slice(0, -2)); // Remove limit e offset para contagem

    res.json({
      vendas,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('Erro ao buscar vendas:', err);
    res.status(500).json({ erro: 'Erro ao buscar vendas' });
  }
});

const upload = multer({ storage: multer.memoryStorage() });

// Rota ajustada para criação de pedido sem obrigatoriedade de valor_pago, exceto para pagamentos em dinheiro ou pix+dinheiro
app.post('/api/pedido_manual', upload.single('comprovante'), async (req, res) => {
  const { cliente_numero, forma_pagamento, itens, valor_pago, valor_dinheiro } = req.body;
  let itensParsed;
try {
  itensParsed = typeof itens === 'string' ? JSON.parse(itens) : itens;
} catch (e) {
  return res.status(400).json({ mensagem: 'Itens do pedido estão em formato inválido.' });
}
  const validPaymentMethods = ['pix', 'dinheiro', 'pix+dinheiro'];

  if (
    !cliente_numero ||
    !forma_pagamento ||
    !validPaymentMethods.includes(forma_pagamento) ||
    !Array.isArray(itensParsed) ||
    itensParsed.length === 0
  ) {
    return res.status(400).json({ mensagem: 'Dados incompletos ou forma de pagamento inválida.' });
  }

  // valor_pago e valor_dinheiro só são exigidos se for dinheiro ou Pix+dinheiro
  if (forma_pagamento === 'pix+dinheiro' || forma_pagamento === 'dinheiro') {
    if (!valor_pago || isNaN(valor_pago)) {
      return res.status(400).json({ mensagem: 'Valor total pago é obrigatório para dinheiro ou PIX + dinheiro.' });
    }
    if (forma_pagamento === 'pix+dinheiro' && (!valor_dinheiro || isNaN(valor_dinheiro))) {
      return res.status(400).json({ mensagem: 'Valor em dinheiro é obrigatório para PIX + dinheiro.' });
    }
  }

  const conn = await db.getConnection();
  await conn.beginTransaction();

  try {
    // Verificar estoque
    for (const item of itensParsed) {
      const [[estoque]] = await conn.query(`SELECT quantidade FROM estoque WHERE id = ?`, [item.produto_id]);
      if (!estoque || estoque.quantidade < item.quantidade) {
        await conn.rollback().catch(() => {});
        return res.status(400).json({ mensagem: `Estoque insuficiente para o produto ${item.produto_id}` });
      }
    }

    // Calcular total
    let valor_total = 0;
    for (const item of itensParsed) {
      const [[produto]] = await conn.query('SELECT valor_unitario FROM estoque WHERE id = ?', [item.produto_id]);
      valor_total += parseFloat(produto.valor_unitario) * item.quantidade;
    }

    // Comprovante
    let comprovanteFile = null;
    if (req.file) {
      if (!['image/jpeg', 'image/png'].includes(req.file.mimetype)) {
        await conn.rollback().catch(() => {});
        return res.status(400).json({ mensagem: 'Comprovante inválido. Envie JPG ou PNG.' });
      }
      comprovanteFile = req.file.buffer;
    }

    // Inserir venda
    const [venda] = await conn.query(`
      INSERT INTO vendas (cliente_numero, forma_pagamento, comprovante, valor_total, valor_pago, valor_dinheiro, status, data, lancameto)
      VALUES (?, ?, ?, ?, ?, ?, 'novo', NOW(), 'manual')
    `, [
      cliente_numero,
      forma_pagamento,
      comprovanteFile,
      valor_total,
      (forma_pagamento === 'pix+dinheiro' || forma_pagamento === 'dinheiro') ? parseFloat(valor_pago || 0) : null,
      (forma_pagamento === 'pix+dinheiro') ? parseFloat(valor_dinheiro || 0) : null
    ]);

    const vendaId = venda.insertId;

    // Inserir pedido
    const [pedido] = await conn.query(`
      INSERT INTO pedidos_diarios (cliente_numero, venda_id, data, status)
      VALUES (?, ?, NOW(), 'novo')
    `, [cliente_numero, vendaId]);

    const pedidoId = pedido.insertId;

    // Inserir itens + baixar estoque
    for (const item of itensParsed) {
      await conn.query(`
        INSERT INTO pedido_itens (pedido_id, produto_id, quantidade)
        VALUES (?, ?, ?)
      `, [pedidoId, item.produto_id, item.quantidade]);

    }

    await conn.commit();
    res.json({ mensagem: 'Pedido criado com sucesso!', pedido_id: pedidoId });

  } catch (erro) {
    await conn.rollback().catch(() => {});
    console.error('Erro ao processar pedido:', erro);
    res.status(500).json({ mensagem: 'Erro interno ao salvar o pedido.', erro: erro.message });
  } finally {
    conn.release();
  }
});





app.patch('/api/vendas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { forma_pagamento, status, valor_total } = req.body;
    if (!forma_pagamento || !status || valor_total === undefined || valor_total === '') {
      return res.status(400).json({ erro: 'Forma de pagamento, status e valor são obrigatórios' });
    }
    const [result] = await db.query(
      'UPDATE vendas SET forma_pagamento = ?, status = ?, valor_total = ? WHERE id = ?',
      [forma_pagamento, status, valor_total, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ erro: 'Venda não encontrada' });
    }
    res.json({ mensagem: 'Venda atualizada com sucesso' });
  } catch (err) {
    console.error('Erro ao atualizar venda:', err);
    res.status(500).json({ erro: 'Erro ao atualizar venda' });
  }
});

app.get('/api/usuarios_web', async (req, res) => {
  try {
    const { busca, page = 1, limit = 10 } = req.query;
    if (page < 1 || limit < 1) {
      return res.status(400).json({ erro: 'Parâmetros de página ou limite inválidos' });
    }
    const offset = (page - 1) * limit;
    const params = busca ? [`%${busca}%`] : [];
    const query = `
      SELECT id, usuario, permissao, data_criacao
      FROM usuarios_web
      ${busca ? 'WHERE usuario LIKE ?' : ''}
      ORDER BY usuario
      LIMIT ? OFFSET ?
    `;
    params.push(parseInt(limit), parseInt(offset));
    const [usuarios] = await db.query(query, params);
    const [[{ total }]] = await db.query('SELECT COUNT(*) as total FROM usuarios_web' + (busca ? ' WHERE usuario LIKE ?' : ''), busca ? [`%${busca}%`] : []);
    res.json({
      usuarios,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('Erro ao buscar usuários web:', err);
    res.status(500).json({ erro: 'Erro ao buscar usuários web' });
  }
});

app.get('/api/usuarios_web/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (isNaN(id)) {
      return res.status(400).json({ erro: 'ID inválido' });
    }
    const [usuarios] = await db.query(`
      SELECT id, usuario, permissao, data_criacao
      FROM usuarios_web
      WHERE id = ?
    `, [id]);
    if (usuarios.length === 0) {
      return res.status(404).json({ erro: 'Usuário web não encontrado' });
    }
    res.json(usuarios[0]);
  } catch (err) {
    console.error('Erro ao buscar usuário web:', err);
    res.status(500).json({ erro: 'Erro ao buscar usuário web' });
  }
});

app.post('/api/usuarios_web', async (req, res) => {
  try {
    const { usuario, senha, permissao } = req.body;
    if (!usuario || !senha || !permissao) {
      return res.status(400).json({ erro: 'Usuário, senha e permissão são obrigatórios' });
    }
    const validPermissions = ['admin', 'vendas', 'producao'];
    if (!validPermissions.includes(permissao)) {
      return res.status(400).json({ erro: 'Permissão inválida' });
    }
    const [existing] = await db.query('SELECT id FROM usuarios_web WHERE usuario = ?', [usuario]);
    if (existing.length > 0) {
      return res.status(400).json({ erro: 'Usuário já existe' });
    }
    const hashedPassword = await bcrypt.hash(senha, 10);
    const [result] = await db.query(`
      INSERT INTO usuarios_web (usuario, senha, permissao, data_criacao)
      VALUES (?, ?, ?, NOW())
    `, [usuario, hashedPassword, permissao]);
    res.status(201).json({ id: result.insertId, mensagem: 'Usuário web adicionado com sucesso' });
  } catch (err) {
    console.error('Erro ao adicionar usuário web:', err);
    res.status(500).json({ erro: 'Erro ao adicionar usuário web' });
  }
});
app.get('/api/usuarios', async (req, res) => {
  try {
    const { busca, page = 1, limit = 10 } = req.query;
    if (page < 1 || limit < 1) {
      return res.status(400).json({ erro: 'Parâmetros de página ou limite inválidos' });
    }
    const offset = (page - 1) * limit;
    const params = busca ? [`%${busca}%`, `%${busca}%`] : [];
    const query = `
      SELECT id, nome, numero, cargo, departamento, email, data_contratacao, salario, data_registro
      FROM usuarios
      ${busca ? 'WHERE nome LIKE ? OR numero LIKE ?' : ''}
      ORDER BY nome
      LIMIT ? OFFSET ?
    `;
    params.push(parseInt(limit), parseInt(offset));
    const [usuarios] = await db.query(query, params);
    const [[{ total }]] = await db.query('SELECT COUNT(*) as total FROM usuarios' + (busca ? ' WHERE nome LIKE ? OR numero LIKE ?' : ''), busca ? [`%${busca}%`, `%${busca}%`] : []);
    res.json({ usuarios, total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Erro ao buscar usuários:', err);
    res.status(500).json({ erro: 'Erro ao buscar usuários' });
  }
});

// GET /api/usuarios/:id
app.get('/api/usuarios/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (isNaN(id)) {
      return res.status(400).json({ erro: 'ID inválido' });
    }
    const [usuarios] = await db.query(`
      SELECT id, nome, numero, cargo, departamento, email, data_contratacao, salario, data_registro
      FROM usuarios
      WHERE id = ?
    `, [id]);
    if (usuarios.length === 0) {
      return res.status(404).json({ erro: 'Usuário não encontrado' });
    }
    res.json(usuarios[0]);
  } catch (err) {
    console.error('Erro ao buscar usuário:', err);
    res.status(500).json({ erro: 'Erro ao buscar usuário' });
  }
});

// POST /api/usuarios
app.post('/api/usuarios', async (req, res) => {
  try {
    const { nome, numero, cargo, departamento, email, data_contratacao, salario } = req.body;
    if (!nome || !numero) {
      return res.status(400).json({ erro: 'Nome e número são obrigatórios' });
    }
    if (!/^\d{10,15}$/.test(numero)) {
      return res.status(400).json({ erro: 'Número deve ter entre 10 e 15 dígitos' });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ erro: 'Email inválido' });
    }
    if (data_contratacao && isNaN(new Date(data_contratacao).getTime())) {
      return res.status(400).json({ erro: 'Data de contratação inválida' });
    }
    const [existing] = await db.query('SELECT id FROM usuarios WHERE numero = ?', [numero]);
    if (existing.length > 0) {
      return res.status(400).json({ erro: 'Número já registrado' });
    }
    const [result] = await db.query(`
      INSERT INTO usuarios (nome, numero, cargo, departamento, email, data_contratacao, salario, data_registro)
      VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
    `, [nome, numero, cargo || null, departamento || null, email || null, data_contratacao || null, salario || null]);
    res.status(201).json({ id: result.insertId, mensagem: 'Usuário adicionado com sucesso' });
  } catch (err) {
    console.error('Erro ao adicionar usuário:', err);
    res.status(500).json({ erro: 'Erro ao adicionar usuário' });
  }
});

app.put('/api/usuarios/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (isNaN(id)) {
      return res.status(400).json({ erro: 'ID inválido' });
    }
    const { nome, numero, cargo, departamento, email, data_contratacao, salario } = req.body;
    if (!nome || !numero) {
      return res.status(400).json({ erro: 'Nome e número são obrigatórios' });
    }
    if (!/^\d{10,15}$/.test(numero)) {
      return res.status(400).json({ erro: 'Número deve ter entre 10 e 15 dígitos' });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ erro: 'Email inválido' });
    }
    if (data_contratacao && isNaN(new Date(data_contratacao).getTime())) {
      return res.status(400).json({ erro: 'Data de contratação inválida' });
    }
    const [existing] = await db.query('SELECT id FROM usuarios WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ erro: 'Usuário não encontrado' });
    }
    const [duplicate] = await db.query('SELECT id FROM usuarios WHERE numero = ? AND id != ?', [numero, id]);
    if (duplicate.length > 0) {
      return res.status(400).json({ erro: 'Número já está em uso' });
    }
    const [result] = await db.query(`
      UPDATE usuarios
      SET nome = ?, numero = ?, cargo = ?, departamento = ?, email = ?, data_contratacao = ?, salario = ?
      WHERE id = ?
    `, [nome, numero, cargo || null, departamento || null, email || null, data_contratacao || null, salario || null, id]);
    res.json({ mensagem: 'Usuário atualizado com sucesso' });
  } catch (err) {
    console.error('Erro ao atualizar usuário:', err);
    res.status(500).json({ erro: 'Erro ao atualizar usuário' });
  }
});

app.get('/api/despesas', async (req, res) => {
  try {
    const { descricao, categoria, tipo } = req.query;
    let query = `
      SELECT id, nome, descricao, valor, categoria, data_despesa, tipo, data_criacao
      FROM despesas
    `;
    const params = [];
    const conditions = [];
    if (descricao) {
      conditions.push('descricao LIKE ?');
      params.push(`%${descricao}%`);
    }
    if (categoria) {
      conditions.push('categoria = ?');
      params.push(categoria);
    }
    if (tipo) {
      conditions.push('tipo = ?');
      params.push(tipo);
    }
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY data_despesa DESC';
    const [despesas] = await db.query(query, params);
    const formattedDespesas = despesas.map(despesa => ({
      ...despesa,
      categoria_nome: despesa.categoria ? despesa.categoria.charAt(0).toUpperCase() + despesa.categoria.slice(1) : 'Sem categoria'
    }));
    res.json(formattedDespesas);
  } catch (err) {
    console.error('Erro ao buscar despesas:', err);
    res.status(500).json({ erro: 'Erro ao buscar despesas' });
  }
});

app.get('/api/despesas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [despesas] = await db.query(`
      SELECT id, nome, descricao, valor, categoria, data_despesa, tipo, data_criacao
      FROM despesas
      WHERE id = ?
    `, [id]);
    if (despesas.length === 0) {
      return res.status(404).json({ erro: 'Despesa não encontrada' });
    }
    const despesa = despesas[0];
    res.json({
      ...despesa,
      categoria_nome: despesa.categoria ? despesa.categoria.charAt(0).toUpperCase() + despesa.categoria.slice(1) : 'Sem categoria'
    });
  } catch (err) {
    console.error('Erro ao buscar despesa:', err);
    res.status(500).json({ erro: 'Erro ao buscar despesa' });
  }
});

app.post('/api/despesas', async (req, res) => {
  try {
    const { nome, descricao, valor, categoria, data_despesa, tipo } = req.body;
    if (!descricao || !valor || !categoria || !data_despesa || !tipo) {
      return res.status(400).json({ erro: 'Os campos descrição, valor, categoria, data da despesa e tipo são obrigatórios' });
    }
    if (valor <= 0) {
      return res.status(400).json({ erro: 'O valor deve ser positivo' });
    }
    if (!['fixa', 'variavel'].includes(tipo)) {
      return res.status(400).json({ erro: 'Tipo inválido. Use "fixa" ou "variavel"' });
    }
    const [result] = await db.query("SHOW COLUMNS FROM despesas WHERE Field = 'categoria'");
    if (result.length === 0) {
      return res.status(500).json({ erro: 'Coluna categoria não encontrada' });
    }
    const enumValues = result[0].Type.match(/enum\((.+)\)/)[1]
      .split(',')
      .map(value => value.replace(/'/g, ''));
    if (!enumValues.includes(categoria)) {
      return res.status(400).json({ erro: `Categoria inválida. Valores permitidos: ${enumValues.join(', ')}` });
    }
    const today = new Date().toISOString().split('T')[0];
    if (data_despesa > today) {
      return res.status(400).json({ erro: 'Data da despesa não pode ser futura' });
    }
    const [insertResult] = await db.query(`
      INSERT INTO despesas (nome, descricao, valor, categoria, data_despesa, tipo, data_criacao)
      VALUES (?, ?, ?, ?, ?, ?, NOW())
    `, [nome || null, descricao, valor, categoria, data_despesa, tipo]);
    res.status(201).json({ id: insertResult.insertId, mensagem: 'Despesa adicionada com sucesso' });
  } catch (err) {
    console.error('Erro ao adicionar despesa:', err);
    res.status(500).json({ erro: 'Erro ao adicionar despesa' });
  }
});

app.put('/api/despesas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, descricao, valor, categoria, data_despesa, tipo } = req.body;
    if (!descricao || !valor || !categoria || !data_despesa || !tipo) {
      return res.status(400).json({ erro: 'Os campos descrição, valor, categoria, data da despesa e tipo são obrigatórios' });
    }
    if (valor <= 0) {
      return res.status(400).json({ erro: 'O valor deve ser positivo' });
    }
    if (!['fixa', 'variavel'].includes(tipo)) {
      return res.status(400).json({ erro: 'Tipo inválido. Use "fixa" ou "variavel"' });
    }
    const [result] = await db.query("SHOW COLUMNS FROM despesas WHERE Field = 'categoria'");
    if (result.length === 0) {
      return res.status(500).json({ erro: 'Coluna categoria não encontrada' });
    }
    const enumValues = result[0].Type.match(/enum\((.+)\)/)[1]
      .split(',')
      .map(value => value.replace(/'/g, ''));
    if (!enumValues.includes(categoria)) {
      return res.status(400).json({ erro: `Categoria inválida. Valores permitidos: ${enumValues.join(', ')}` });
    }
    const today = new Date().toISOString().split('T')[0];
    if (data_despesa > today) {
      return res.status(400).json({ erro: 'Data da despesa não pode ser futura' });
    }
    const [existing] = await db.query('SELECT id FROM despesas WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ erro: 'Despesa não encontrada' });
    }
    const [updateResult] = await db.query(`
      UPDATE despesas
      SET nome = ?, descricao = ?, valor = ?, categoria = ?, data_despesa = ?, tipo = ?
      WHERE id = ?
    `, [nome || null, descricao, valor, categoria, data_despesa, tipo, id]);
    res.json({ mensagem: 'Despesa atualizada com sucesso' });
  } catch (err) {
    console.error('Erro ao atualizar despesa:', err);
    res.status(500).json({ erro: 'Erro ao atualizar despesa' });
  }
});

app.delete('/api/despesas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [existing] = await db.query('SELECT id FROM despesas WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ erro: 'Despesa não encontrada' });
    }
    const [result] = await db.query('DELETE FROM despesas WHERE id = ?', [id]);
    res.json({ mensagem: 'Despesa deletada com sucesso' });
  } catch (err) {
    console.error('Erro ao deletar despesa:', err);
    res.status(500).json({ erro: 'Erro ao deletar despesa' });
  }
});

app.get('/api/categorias/despesas', async (req, res) => {
  try {
    const [result] = await db.query("SHOW COLUMNS FROM despesas WHERE Field = 'categoria'");
    if (result.length === 0) {
      return res.status(500).json({ erro: 'Coluna categoria não encontrada' });
    }
    const enumValues = result[0].Type.match(/enum\((.+)\)/)[1]
      .split(',')
      .map(value => value.replace(/'/g, ''))
      .filter(value => value !== '');
    const categorias = enumValues.map(value => ({
      id: value,
      nome: value.charAt(0).toUpperCase() + value.slice(1)
    }));
    res.json(categorias);
  } catch (err) {
    console.error('Erro ao listar categorias:', err);
    res.status(500).json({ erro: 'Erro ao listar categorias' });
  }
});

app.post('/api/despesas/categorias/adicionar', async (req, res) => {
  try {
    const { novaCategoria } = req.body;
    if (!novaCategoria || typeof novaCategoria !== 'string' || novaCategoria.trim() === '') {
      return res.status(400).json({ erro: 'O nome da nova categoria é obrigatório e deve ser uma string válida' });
    }
    const categoriaNormalizada = novaCategoria.trim().toLowerCase().replace(/\s+/g, '_');
    if (!/^[a-z_]{1,50}$/.test(categoriaNormalizada)) {
      return res.status(400).json({ erro: 'O nome da categoria deve conter apenas letras e underscores, até 50 caracteres' });
    }
    const [result] = await db.query("SHOW COLUMNS FROM despesas WHERE Field = 'categoria'");
    if (result.length === 0) {
      return res.status(404).json({ erro: 'Coluna categoria não encontrada' });
    }
    const enumValues = result[0].Type.match(/enum\((.+)\)/)[1]
      .split(',')
      .map(value => value.replace(/'/g, ''))
      .filter(value => value !== '');
    if (enumValues.includes(categoriaNormalizada)) {
      return res.status(400).json({ erro: 'Categoria já existe' });
    }
    const novosValores = [...enumValues, categoriaNormalizada];
    const novosValoresStr = novosValores.map(value => `'${value}'`).join(',');
    await db.query(`ALTER TABLE despesas MODIFY COLUMN categoria ENUM(${novosValoresStr}) NOT NULL`);
    res.status(201).json({ mensagem: 'Categoria adicionada com sucesso', categoria: categoriaNormalizada });
  } catch (error) {
    console.error('Erro ao adicionar categoria:', error);
    res.status(500).json({ erro: 'Erro ao adicionar categoria' });
  }
});

app.get('/api/despesas/relatorio', async (req, res) => {
  try {
    const [relatorio] = await db.query(`
      SELECT DATE_FORMAT(data_despesa, '%Y-%m') AS mes, SUM(valor) AS total
      FROM despesas
      GROUP BY mes
      ORDER BY mes DESC
    `);
    res.json(relatorio);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao gerar relatório' });
  }
});

app.delete('/api/usuarios/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (isNaN(id)) {
      return res.status(400).json({ erro: 'ID inválido' });
    }
    const [existing] = await db.query('SELECT id FROM usuarios WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ erro: 'Usuário não encontrado' });
    }
    const [dependencias] = await db.query('SELECT COUNT(*) as count FROM entregas WHERE entregador_id = ?', [id]);
    if (dependencias[0].count > 0) {
      return res.status(400).json({ erro: 'Usuário não pode ser deletado pois está associado a entregas' });
    }
    const [result] = await db.query('DELETE FROM usuarios WHERE id = ?', [id]);
    res.json({ mensagem: 'Usuário deletado com sucesso' });
  } catch (err) {
    console.error('Erro ao deletar usuário:', err);
    res.status(500).json({ erro: 'Erro ao deletar usuário' });
  }
});

app.get('/api/entregas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const query = `
      SELECT 
        pedido_id,
        cliente_numero,
        itens,
        status,
        rota,
        entregador_id,
        hora_inicio,
        hora_fim,
        data_pedido,
        observacoes,
        recebido
      FROM entregas
      WHERE pedido_id = ?
    `;
    const [result] = await db.query(query, [id]);
    if (result.length === 0) {
      return res.status(404).json({ erro: `Pedido com ID ${id} não encontrado` });
    }
    res.json(result[0]);
  } catch (err) {
    console.error('Erro ao buscar detalhes do pedido:', err);
    res.status(500).json({ erro: `Falha ao buscar detalhes do pedido. Detalhes: ${err.message}` });
  }
});

app.get('/api/entregas', async (req, res) => {
  try {
    const { cliente_numero, data_inicio, data_fim, status, rota } = req.query;
    const params = [];
    let whereClauses = [];
    if (cliente_numero) {
      whereClauses.push('e.cliente_numero LIKE ?');
      params.push(`%${cliente_numero}%`);
    }
    if (data_inicio) {
      whereClauses.push('DATE(e.data_pedido) >= ?');
      params.push(data_inicio);
    }
    if (data_fim) {
      whereClauses.push('DATE(e.data_pedido) <= ?');
      params.push(data_fim);
    }
    if (status) {
      whereClauses.push('e.status = ?');
      params.push(status);
    }
    if (rota) {
      whereClauses.push('e.rota = ?');
      params.push(rota);
    }
    const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const query = `
      SELECT 
        e.pedido_id,
        e.cliente_numero,
        e.itens,
        e.status,
        e.rota,
        e.entregador_id,
        e.hora_inicio,
        e.hora_fim,
        e.data_pedido
      FROM entregas e
      ${where}
      ORDER BY e.data_pedido DESC
      LIMIT 100
    `;
    const [entregas] = await db.query(query, params);
    res.json(entregas);
  } catch (err) {
    console.error('Erro ao buscar entregas:', err);
    res.status(500).json({ erro: 'Erro ao buscar entregas' });
  }
});

app.get('/api/entregadores', async (req, res) => {
  try {
    const busca = req.query.busca || '';
    const params = busca ? [`%${busca}%`] : [];
    const query = `
      SELECT 
        entregador,
        quantidade_pedidos,
        tempo_medio_pedido,
        km
      FROM entregador
      ${busca ? 'WHERE entregador LIKE ?' : ''}
      ORDER BY hora_fim DESC
      LIMIT 100
    `;
    const [entregadores] = await db.query(query, params);
    res.json(entregadores);
  } catch (err) {
    console.error('Erro ao buscar entregadores:', err);
    res.status(500).json({ erro: 'Erro ao buscar entregadores' });
  }
});

app.put('/api/usuarios_web/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (isNaN(id)) {
      return res.status(400).json({ erro: 'ID inválido' });
    }
    const { usuario, senha, permissao } = req.body;
    if (!usuario || !senha || !permissao) {
      return res.status(400).json({ erro: 'Usuário, senha e permissão são obrigatórios' });
    }
    const validPermissions = ['admin', 'vendas', 'producao'];
    if (!validPermissions.includes(permissao)) {
      return res.status(400).json({ erro: 'Permissão inválida' });
    }
    const [existing] = await db.query('SELECT id FROM usuarios_web WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ erro: 'Usuário web não encontrado' });
    }
    const [duplicate] = await db.query('SELECT id FROM usuarios_web WHERE usuario = ? AND id != ?', [usuario, id]);
    if (duplicate.length > 0) {
      return res.status(400).json({ erro: 'Novo nome de usuário já está em uso' });
    }
    const hashedPassword = await bcrypt.hash(senha, 10);
    const [result] = await db.query(`
      UPDATE usuarios_web
      SET usuario = ?, senha = ?, permissao = ?
      WHERE id = ?
    `, [usuario, hashedPassword, permissao, id]);
    res.json({ mensagem: 'Usuário web atualizado com sucesso' });
  } catch (err) {
    console.error('Erro ao atualizar usuário web:', err);
    res.status(500).json({ erro: 'Erro ao atualizar usuário web' });
  }
});

app.delete('/api/usuarios_web/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (isNaN(id)) {
      return res.status(400).json({ erro: 'ID inválido' });
    }
    const [existing] = await db.query('SELECT id FROM usuarios_web WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ erro: 'Usuário web não encontrado' });
    }
    const [result] = await db.query('DELETE FROM usuarios_web WHERE id = ?', [id]);
    res.json({ mensagem: 'Usuário web deletado com sucesso' });
  } catch (err) {
    console.error('Erro ao deletar usuário web:', err);
    res.status(500).json({ erro: 'Erro ao deletar usuário web' });
  }
});

app.get('/api/entregasmetricas', async (req, res) => {
  try {
    await db.query('SELECT 1');
    const [totalResult] = await db.query('SELECT COUNT(*) as total FROM entregas');
    const totalEntregas = totalResult[0].total || 0;
    const [finalizadasResult] = await db.query('SELECT COUNT(*) as total FROM entregas WHERE status = ?', ['finalizado']);
    const entregasFinalizadas = finalizadasResult[0].total || 0;
    const [falhaResult] = await db.query('SELECT COUNT(*) as total FROM entregas WHERE status = ?', ['falha']);
    const entregasFalha = falhaResult[0].total || 0;
    const [tempoMedioResult] = await db.query(`
      SELECT AVG(TIMESTAMPDIFF(MINUTE, hora_inicio, hora_fim)) as tempo_medio
      FROM entregas
      WHERE hora_inicio IS NOT NULL AND hora_fim IS NOT NULL AND status = 'finalizado'
    `);
    const tempoMedio = Math.round(tempoMedioResult[0].tempo_medio) || 0;
    const [statusResult] = await db.query(`
      SELECT status, COUNT(*) as quantidade
      FROM entregas
      GROUP BY status
    `);
    const statusDistribuicao = {};
    statusResult.forEach(row => {
      statusDistribuicao[row.status || 'desconhecido'] = row.quantidade;
    });

    const [entregadorResult] = await db.query(`
      SELECT entregador_id, COUNT(*) as quantidade
      FROM entregas
      GROUP BY entregador_id
    `);
    const entregadorDistribuicao = entregadorResult.map(row => ({
      entregador_id: row.entregador_id || 'N/A',
      quantidade: row.quantidade
    }));
    const [diariasResult] = await db.query(`
      SELECT DATE(data_pedido) as data, COUNT(*) as quantidade
      FROM entregas
      WHERE data_pedido >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
      GROUP BY DATE(data_pedido)
      ORDER BY data
    `);
    const entregasDiarias = diariasResult.map(row => ({
      data: row.data,
      quantidade: row.quantidade
    }));
    res.json({
      totalEntregas,
      entregasFinalizadas,
      entregasFalha,
      tempoMedio,
      statusDistribuicao,
      entregadorDistribuicao,
      entregasDiarias
    });
  } catch (err) {
    console.error('Erro ao buscar métricas:', err);
    res.status(500).json({ erro: `Falha ao buscar métricas. Detalhes: ${err.message}` });
  }
});

app.post('/editar_pagamento', async (req, res) => {
  const { id, forma_pagamento } = req.body;
  try {
    await db.query('UPDATE vendas SET forma_pagamento = ? WHERE id = ?', [forma_pagamento, id]);
    res.json({ mensagem: 'Forma de pagamento atualizada com sucesso!' });
  } catch (err) {
    console.error('Erro ao editar forma de pagamento:', err);
    res.status(500).json({ erro: 'Erro ao editar forma de pagamento' });
  }
});


app.post('/editar_itens', async (req, res) => {
  const { pedido_id, itens } = req.body;

  if (!Array.isArray(itens) || itens.length === 0) {
    return res.status(400).json({ erro: 'Itens inválidos' });
  }

  try {
    // Remove os itens anteriores do pedido
    await db.query('DELETE FROM pedido_itens WHERE pedido_id = ?', [pedido_id]);

    // Adiciona os novos itens
    for (const item of itens) {
      const { produto_id, quantidade } = item;
      if (produto_id && quantidade > 0) {
        await db.query(
          'INSERT INTO pedido_itens (pedido_id, produto_id, quantidade) VALUES (?, ?, ?)',
          [pedido_id, produto_id, quantidade]
        );
      }
    }

    res.json({ mensagem: 'Itens do pedido atualizados com sucesso!' });
  } catch (err) {
    console.error('Erro ao editar itens do pedido:', err);
    res.status(500).json({ erro: 'Erro ao editar itens do pedido' });
  }
});

app.get('/api/pedidos/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const [resultado] = await db.query(`
      SELECT 
        pd.id AS pedido_id,
        pd.cliente_numero,
        pd.status,
        pd.data_hora AS data_pedido,
        COALESCE(v.forma_pagamento, '-') AS forma_pagamento,
        COALESCE(v.valor_total, '-') AS valor_total,
        GROUP_CONCAT(CONCAT(pi.quantidade, 'x ', e.nome) SEPARATOR ', ') AS itens
      FROM pedidos_diarios pd
      LEFT JOIN vendas v ON v.id = pd.venda_id
      LEFT JOIN pedido_itens pi ON pi.pedido_id = pd.id
      LEFT JOIN estoque e ON e.id = pi.produto_id
      WHERE pd.id = ?
      GROUP BY pd.id
      LIMIT 1
    `, [id]);

    if (!resultado || resultado.length === 0) {
      return res.status(404).json({ erro: "Pedido não encontrado" });
    }

    res.json(resultado[0]);
  } catch (err) {
    console.error("Erro ao buscar detalhes do pedido:", err);
    res.status(500).json({ erro: "Erro ao buscar pedido" });
  }
});


// Rota para listar pedidos pendentes (valido = 0)
app.get('/api/pedidos_pendentes', async (req, res) => {
  try {
    const [pedidos] = await db.query(`
      SELECT 
          pd.id,
          pd.cliente_numero,
          pd.status,
          pd.valido,
          pd.venda_id,
          pd.numero_diario,
          v.valor_total AS valor_total
      FROM pedidos_diarios pd
      LEFT JOIN vendas v ON pd.venda_id = v.id
      WHERE pd.valido IS NULL
      ORDER BY pd.data_hora DESC
    `);
    res.json(pedidos);
  } catch (err) {
    console.error('Erro ao buscar pedidos pendentes:', err);
    res.status(500).json({ erro: 'Erro ao buscar pedidos pendentes' });
  }
});


app.listen(port, () => {
  console.log(`🟢 Servidor rodando em http://localhost:${port}`);
});