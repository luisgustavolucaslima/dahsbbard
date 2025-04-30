const express = require('express');
const mysql = require('mysql2/promise');
const app = express();
const port = 3000;
const usuariosPermitidos = ['usuario1', 'usuario2'];

const db = mysql.createPool({
  host: '127.0.0.1',
  user: 'root',
  password: '',
  database: 'iceclubestoque'
});

app.use(express.static('.'));
app.use(express.json());

app.get('/pedidos_diarios', async (req, res) => {
  try {
    const [pedidos] = await db.query(
      "SELECT * FROM pedidos_diarios WHERE DATE(data) = CURDATE() ORDER BY data"
    );
    res.json(pedidos); 
  } catch (err) {
    console.error("Erro ao buscar pedidos:", err);
    res.status(500).json({ erro: 'Erro ao buscar pedidos' });
  }
});


app.post('/alterar_status', async (req, res) => {
  const { id, statusAtual } = req.body;

  // Define próxima etapa do fluxo
  const transicoes = {
    novo: 'embalado',
    embalado: 'entrega',
    entrega: 'rua',
    rua: 'finalizado'
  };

  const novoStatus = transicoes[statusAtual] || statusAtual;

  try {
    await db.query("UPDATE pedidos_diarios SET status = ? WHERE id = ?", [novoStatus, id]);
    res.status(200).json({ mensagem: `Status alterado para ${novoStatus}` });
  } catch (err) {
    console.error("Erro ao alterar status:", err);
    res.status(500).json({ erro: 'Erro ao alterar status do pedido.' });
  }
});


app.get('/resumo_diario', async (req, res) => {
  try {
    const [[{ total_vendas, total_valor }]] = await db.query(`
      SELECT COUNT(*) AS total_vendas, SUM(valor_pago) AS total_valor
      FROM pedidos_diarios
      WHERE DATE(data) = CURDATE()
    `);
    res.json({ total_vendas, total_valor: total_valor || 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao buscar resumo' });
  }
});

app.post('/enviar_para_entrega', async (req, res) => {
  try {
    // 📍 Recebe a rota enviada pelo front-end
    const { rota } = req.body;

    // 1️⃣ Busca só os pedidos com status 'entrega' de hoje
    const [pedidos] = await db.query(`
      SELECT id, cliente_numero, itens, data, endereco, recebido
      FROM pedidos_diarios
      WHERE status = 'entrega' AND DATE(data) = CURDATE()
    `);
    const quantidade_pedidos = pedidos.length;

    // 2️⃣ Insere cada um na tabela de entregas
    for (const pedido of pedidos) {
      await db.query(`
        INSERT INTO entregas
          (pedido_id, cliente_numero, itens, endereco, recebido, rota, data_pedido)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        pedido.id,
        pedido.cliente_numero,
        pedido.itens,
        pedido.endereco,
        pedido.recebido,
        rota,
        pedido.data   // data_pedido
      ]);
    }

    return res
      .status(200)
      .json({ mensagem: `Pedidos enviados para rota ${rota}. Total de pedidos: ${quantidade_pedidos}` });
  } catch (erro) {
    console.error('Erro em /enviar_para_entrega:', erro);
    return res
      .status(500)
      .json({ mensagem: 'Erro ao processar os pedidos para entrega.', erro: erro.message });
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

  try {
    if (valido == 0) {
      await db.query("UPDATE pedidos_diarios SET valido = ?, status = 'finalizado' WHERE id = ?", [valido, id]);
    } else {
      await db.query("UPDATE pedidos_diarios SET valido = ? WHERE id = ?", [valido, id]);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Erro ao atualizar validade do pedido:", err);
    res.status(500).send("Erro interno ao atualizar validade.");
  }
});

app.post('/login', async (req, res) => {
  const { usuario, senha } = req.body;

  const [usuarios] = await db.query("SELECT * FROM usuarios_web WHERE usuario = ? AND senha = ?", [usuario, senha]);

  if (usuarios.length) {
    return res.json({ usuario: usuarios[0].usuario, permissao: usuarios[0].permissao });
  }

  res.status(401).send("Usuário ou senha inválidos");
});



app.get('/comprovante/:id', async (req, res) => {
  try {
    const [rows] = await db.query("SELECT comprovante FROM pedidos_diarios WHERE id = ?", [req.params.id]);
    if (!rows.length || !rows[0].comprovante) return res.sendStatus(404);
    res.set('Content-Type', 'image/png').send(rows[0].comprovante);
  } catch (err) {
    res.status(500).send('Erro ao carregar comprovante.');
  }
});


app.get('/api/vendas-por-cliente', async (req, res) => {
  try {
    const busca = req.query.busca || '';
    const params = busca ? [`%${busca}%`] : [];
    const query = `
      SELECT 
        cliente_numero,
        COUNT(*) AS total_vendas,
        SUM(valor_pago) AS valor_total,
        MAX(data) AS ultima_compra
      FROM vendas
      ${busca ? 'WHERE cliente_numero LIKE ?' : ''}
      GROUP BY cliente_numero
      ORDER BY ultima_compra DESC
    `;
    const [clientes] = await db.query(query, params);
    res.json(clientes);
  } catch (err) {
    console.error('Erro ao buscar vendas por cliente:', err);
    res.status(500).json({ erro: 'Erro ao buscar vendas por cliente' });
  }
});

app.get('/api/estoque', async (req, res) => {
  try {
    const { nome, categoria, estoque_baixo } = req.query;
    const params = [];
    let whereClauses = [];

    if (nome) {
      whereClauses.push('nome LIKE ?');
      params.push(`%${nome}%`);
    }
    if (categoria) {
      whereClauses.push('categoria = ?');
      params.push(categoria);
    }
    if (estoque_baixo === 'baixo') {
      whereClauses.push('quantidade < 10');
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
    `;

    const [itens] = await db.query(query, params);
    res.json(itens);
  } catch (err) {
    console.error('Erro ao buscar estoque:', err);
    res.status(500).json({ erro: 'Erro ao buscar estoque' });
  }
});

// Endpoint para adicionar item
app.post('/api/estoque', async (req, res) => {
  try {
    const { nome, quantidade, preco, categoria } = req.body;

    if (!nome || quantidade === undefined || preco === undefined || !categoria) {
      return res.status(400).json({ erro: 'Todos os campos são obrigatórios' });
    }

    const [result] = await db.query(
      'INSERT INTO estoque (nome, quantidade, valor_unitario, categoria, ultima_atualizacao = NOW()) VALUES (?, ?, ?, ?)',
      [nome, quantidade, preco, categoria]
    );

    res.status(201).json({ id: result.insertId, mensagem: 'Item adicionado com sucesso' });
  } catch (err) {
    console.error('Erro ao adicionar item:', err);
    res.status(500).json({ erro: 'Erro ao adicionar item' });
  }
});

app.get('/api/dashboard', async (req, res) => {
  try {
    // Total vendas e receita
    const [[vendasInfo]] = await db.query(`
      SELECT 
        COUNT(*) AS totalVendas, 
        SUM(valor_pago) AS totalReceita,
        AVG(valor_pago) AS valorMedio
      FROM vendas
      WHERE DATE(data) = CURDATE()
    `);

    // Itens em baixo estoque
    const [[baixoEstoque]] = await db.query(`
      SELECT COUNT(*) AS baixoEstoque
      FROM estoque
      WHERE quantidade < 10
    `);

    // Top compradores
    const [topCompradores] = await db.query(`
      SELECT 
        cliente_numero,
        COUNT(*) AS total_compras,
        SUM(valor_pago) AS valor_total,
        MAX(data) AS ultima_compra
      FROM vendas
      GROUP BY cliente_numero
      ORDER BY valor_total DESC
      LIMIT 5
    `);

    // Top produtos (assumindo itens é JSON com id e quantidade)
// Top produtos (assumindo itens é uma string com nomes de produtos, e.g., "laranja" ou "laranja,maçã")
const [vendas] = await db.query(`
  SELECT itens
  FROM vendas
  WHERE DATE(data) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
`);

const produtoVendas = {};
for (const venda of vendas) {
  try {
    // Tratar itens como string; dividir por vírgula se for uma lista
    const itens = venda.itens.split(',').map(item => item.trim());
    for (const nomeProduto of itens) {
      if (nomeProduto) {
        // Buscar o produto no estoque pelo nome
        const [[produto]] = await db.query('SELECT id, nome, valor_unitario, categoria FROM estoque WHERE nome = ?', [nomeProduto]);
        if (produto) {
          const id = produto.id;
          if (!produtoVendas[id]) {
            produtoVendas[id] = { quantidade: 0, receita: 0 };
          }
          produtoVendas[id].quantidade += 1; // Assumindo 1 unidade por menção; ajustar se quantidade for especificada
          produtoVendas[id].receita += produto.valor_unitario;
        }
      }
    }
  } catch (e) {
    console.warn('Erro ao processar itens:', venda.itens, e.message);
  }
}

const topProdutos = await Promise.all(
  Object.keys(produtoVendas).map(async id => {
    const [[produto]] = await db.query('SELECT nome, valor_unitario, categoria FROM estoque WHERE id = ?', [id]);
    if (produto) {
      return {
        id,
        nome: produto.nome,
        categoria: produto.categoria,
        quantidade_vendida: produtoVendas[id].quantidade,
        receita_total: produtoVendas[id].receita
      };
    }
    return null;
  })
);

const topProdutosFiltrados = topProdutos
  .filter(p => p)
  .sort((a, b) => b.quantidade_vendida - a.quantidade_vendida)
  .slice(0, 5);

    // Vendas diárias (últimos 30 dias)
    const [vendasDiarias] = await db.query(`
      SELECT 
        DATE(data) AS data,
        SUM(valor_pago) AS receita
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
      topProdutos: topProdutosFiltrados,
      vendasDiarias
    });
  } catch (err) {
    console.error('Erro ao buscar dados do dashboard:', err);
    res.status(500).json({ erro: 'Erro ao buscar dados do dashboard' });
  }
});

// Endpoint para atualizar item
app.patch('/api/estoque/:id', async (req, res) => {
  try {
    const { id: currentId } = req.params;
    const { id: newId, nome, quantidade, preco, categoria } = req.body;

    if (!nome || quantidade === undefined || preco === undefined || !categoria) {
      return res.status(400).json({ erro: 'Nome, quantidade, preço e categoria são obrigatórios' });
    }

    // Check if newId is provided and unique
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

// Endpoint para deletar item
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


app.listen(port, () => {
  console.log(`🟢 Servidor rodando em http://localhost:${port}`);
});

app.get('/entregas', async (req, res) => {
  try {
    const [dados] = await db.query(`
      SELECT entregador, quantidade_pedidos, hora_inicio, hora_fim, tempo_medio
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

// Novas rotas para admin.html
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
      SELECT pedido_id, entregador_id, endereco, hora_inicio
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

app.get('/api/vendas', async (req, res) => {
  try {
    const { cliente_numero, data_inicio, data_fim, status } = req.query;
    const params = [];
    let whereClauses = [];

    if (cliente_numero) {
      whereClauses.push('cliente_numero LIKE ?');
      params.push(`%${cliente_numero}%`);
    }
    if (data_inicio) {
      whereClauses.push('DATE(data) >= ?');
      params.push(data_inicio);
    }
    if (data_fim) {
      whereClauses.push('DATE(data) <= ?');
      params.push(data_fim);
    }
    if (status) {
      whereClauses.push('status = ?');
      params.push(status);
    }

    const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const query = `
      SELECT 
        id,
        COALESCE(cliente_numero, '') AS cliente_numero,
        COALESCE(valor_pago, 0) AS valor_pago,
        COALESCE(forma_pagamento, 'pix') AS forma_pagamento,
        COALESCE(data, NOW()) AS data,
        COALESCE(endereco, '') AS endereco,
        COALESCE(status, 'novo') AS status,
        comprovante IS NOT NULL AS tem_comprovante
      FROM vendas
      ${where}
      ORDER BY data DESC
    `;

    const [vendas] = await db.query(query, params);
    res.json(vendas);
  } catch (err) {
    console.error('Erro ao buscar vendas:', err);
    res.status(500).json({ erro: 'Erro ao buscar vendas' });
  }
});

app.patch('/api/vendas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { forma_pagamento, status, valor_pago} = req.body;

    if (!forma_pagamento || !status || valor_pago === undefined || valor_pago === '') {
      return res.status(400).json({ erro: 'Forma de pagamento, status e valor são obrigatórios' });
    }
    

    const [result] = await db.query(
      'UPDATE vendas SET forma_pagamento = ?, status = ?, valor_pago = ? WHERE id = ?',
      [forma_pagamento, status, valor_pago, id]
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