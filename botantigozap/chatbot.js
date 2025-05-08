const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const mysql = require('mysql2/promise');
const moment = require('moment');
const axios = require('axios');
const GOOGLE_API_KEY = 'AIzaSyBpqMDBX4ic49y85K4-3dNJyxkZwD2rZ9c'; // substitua pela sua chave real
const SENHA_MESTRE = '#acesso123';
const tratarEstoque = require('./setores/estoque');
const tratarEntrega = require('./setores/entrega');
const tratarVendas = require('./setores/vendas');
const client = new Client();
const db = mysql.createPool({ host: 'localhost', user: 'root', password: '', database: 'iceclubestoque' });

const sessoes = new Map(); // controle de sessão ativa

client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('✅ Bot pronto!'));

client.on('message', async msg => {
  const numero = msg.from.replace('@c.us', '');
  const hoje = moment().format('YYYY-MM-DD');
  const texto = msg.body.trim();
  const [usuarios] = await db.query('SELECT * FROM usuarios WHERE numero = ?', [numero]);

  let sessao = sessoes.get(numero) || { setor: null, data: hoje, autenticado: false };

  // Reseta sessão se for de outro dia
  if (sessao.data !== hoje) {
    sessao = { setor: null, data: hoje, autenticado: false };
    sessoes.set(numero, sessao);
  }

  // NOVO USUÁRIO
  if (!usuarios.length) {
    if (texto !== SENHA_MESTRE) return msg.reply('🔒 Envie a senha de acesso para registrar-se.');
    await db.query('INSERT INTO usuarios (numero, nome, senha, ultima_sessao) VALUES (?, ?, ?, ?)', [numero, numero, null, hoje]);
    sessoes.set(numero, sessao);
    return msg.reply('✅ Acesso liberado! Agora, envie sua senha pessoal para completar o cadastro.');
  }

  const usuario = usuarios[0];

  // USUÁRIO EXISTE MAS SEM SENHA
  if (!usuario.senha) {
    if (texto.length < 4) return msg.reply('❗ A senha deve ter pelo menos 4 caracteres.');
    await db.query('UPDATE usuarios SET senha = ?, ultima_sessao = ? WHERE numero = ?', [texto, hoje, numero]);
    sessoes.set(numero, sessao);
    return msg.reply('✅ Conta criada com sucesso!\n🔓 Escolha um setor:\n1️⃣ Entrega\n2️⃣ Estoque\n3️⃣ Vendas');
  }

  // VERIFICAÇÃO DE SENHA PESSOAL
  if (!sessao.logado) {
    if (texto !== usuario.senha) return msg.reply('❌ Senha incorreta. Envie sua senha pessoal para acessar.');
    sessao.logado = true;
    sessoes.set(numero, sessao);
    return msg.reply('🔓 Login diário realizado!\n\nEscolha:\n1️⃣ Entrega\n2️⃣ Estoque\n3️⃣ Vendas');
  }

  // SAIR
  if (texto.toLowerCase() === 'sair') {
    sessoes.delete(numero);
    return msg.reply('🛑 Você saiu do fluxo. Para começar de novo, envie "oi".');
  }

  // SELEÇÃO DE SETOR
  if (['1', '2', '3'].includes(texto)) {
    if (sessao.autenticado) {
      return msg.reply('⚠️ Você já está autenticado em um setor. Envie "sair" para reiniciar.');
    }
    const setores = { '1': 'entrega', '2': 'estoque', '3': 'vendas' };
    sessao.setor = setores[texto];
    sessoes.set(numero, sessao);
    return msg.reply(`🔑 Setor selecionado: ${sessao.setor.toUpperCase()}\nEnvie a senha do setor para continuar.`);
  }
  

  // VERIFICA SE ESCOLHEU SETOR
  if (!sessao.setor) {
    return msg.reply('ℹ️ Escolha um setor para continuar:\n1️⃣ Entrega\n2️⃣ Estoque\n3️⃣ Vendas');
  }

  // AUTENTICAÇÃO DO SETOR
  const senhasSetor = { entrega: 'entrega123', estoque: 'estoque123', vendas: 'venda123' };
  if (!sessao.autenticado) {
    if (texto === senhasSetor[sessao.setor]) {
      sessao.autenticado = true;
      sessoes.set(numero, sessao); // <- garante que o estado foi salvo
      return msg.reply(`✅ Acesso ao setor ${sessao.setor.toUpperCase()} liberado.`);
    } else {
      return msg.reply(`🔐 Envie a senha correta do setor *${sessao.setor.toUpperCase()}* para acessar.`);
    }
  }
  

  // EXECUTA O FLUXO DO SETOR
  try {
    switch (sessao.setor) {
      case 'vendas':
        return await tratarVendas(texto, msg, sessao, db, client);
      case 'estoque':
        return await tratarEstoque(texto, msg, sessao, db, client);
      case 'entrega':
        return await tratarEntrega(texto, msg, sessao, db, client, numero, sessoes);
      default:
        return msg.reply('❓ Setor inválido. Envie "1", "2" ou "3" para escolher.');
    }
  } catch (err) {
    console.error('Erro no setor:', err);
    return msg.reply('⚠️ Ocorreu um erro ao processar sua solicitação.');
  }
});

client.initialize();