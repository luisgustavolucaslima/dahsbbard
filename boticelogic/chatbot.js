const TelegramBot = require('node-telegram-bot-api');
const mysql = require('mysql2/promise');
const moment = require('moment');
const bcrypt = require('bcrypt');
require('dotenv').config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SENHA_MESTRE = '#acesso123';
const { tratarEntrega, configurarEntrega } = require('./setores/entrega');
const tratarVendas = require('./setores/vendas');

// Configurações de timeout
const SESSION_TIMEOUT = 15 * 60 * 1000; // 15 minutos
const MESSAGE_TIMEOUT = 100000; // 5 minutos

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const db = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'iceclubestoque'
});

const sessoes = new Map();

// Configura os listeners do setor entrega
configurarEntrega(bot, db, sessoes);

console.log('[INFO] ✅ Bot do Telegram iniciado!');

// Função para verificar permissões do bot
const verificarPermissoes = async (chatId) => {
  try {
    const chatMember = await bot.getChatMember(chatId, bot.id);
    return chatMember.can_delete_messages || false;
  } catch (err) {
    console.error(`[ERROR] Erro ao verificar permissões para ${chatId}:`, err.message);
    return false;
  }
};

// Função para enviar mensagem com timeout de exclusão
const enviarMensagem = async (chatId, mensagem, options = {}, persistente = false) => {
  try {
    if (!chatId || !mensagem) {
      console.error('[ERROR] Parâmetros inválidos para enviarMensagem:', { chatId, mensagem });
      return null;
    }
    const sentMessage = await bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown', ...options });
    const sessao = sessoes.get(chatId) || { messageIds: [] };
    sessao.messageIds = sessao.messageIds || [];
    sessao.messageIds.push(sentMessage.message_id);
    sessoes.set(chatId, sessao);
    if (!persistente && !options.reply_markup?.inline_keyboard) {
      setTimeout(async () => {
        try {
          await bot.deleteMessage(chatId, sentMessage.message_id);
          console.log(`[DEBUG] Mensagem ${sentMessage.message_id} deletada após ${MESSAGE_TIMEOUT}ms`);
        } catch (err) {
          console.error(`[ERROR] Erro ao deletar mensagem ${sentMessage.message_id}:`, err.message);
        }
      }, MESSAGE_TIMEOUT);
    }
    return sentMessage;
  } catch (err) {
    console.error(`[ERROR] Erro ao enviar mensagem para ${chatId}:`, err.message);
    return null;
  }
};

// Função para enviar mensagem persistente (sem deleção)
const enviarMensagemPersistente = async (chatId, mensagem, options = {}) => {
  try {
    if (!chatId || !mensagem) {
      console.error('[ERROR] Parâmetros inválidos para enviarMensagemPersistente:', { chatId, mensagem });
      return null;
    }
    const sentMessage = await bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown', ...options });
    const sessao = sessoes.get(chatId) || { messageIds: [] };
    sessao.messageIds = sessao.messageIds || [];
    sessao.messageIds.push(sentMessage.message_id);
    sessoes.set(chatId, sessao);
    return sentMessage;
  } catch (err) {
    console.error(`[ERROR] Erro ao enviar mensagem persistente para ${chatId}:`, err.message);
    return null;
  }
};

// Função para enviar mensagem com botão de sair
const enviarBotaoSair = async (chatId, mensagem) => {
  const keyboard = {
    inline_keyboard: [[{ text: '🛑 Sair', callback_data: 'sair' }]]
  };
  return enviarMensagem(chatId, mensagem, { reply_markup: keyboard });
};

// Função para enviar menu de setores com base no cargo
const enviarMenuSetores = async (chatId, cargo, enviarMensagem) => {
  console.log(`[DEBUG] Enviando menu de setores para cargo: ${cargo || 'nulo'}`);
  if (!chatId || !enviarMensagem) {
    console.error('[ERROR] Parâmetros inválidos para enviarMenuSetores:', { chatId, enviarMensagem });
    return enviarMensagem(chatId, '⚠️ *Erro interno. Tente novamente.*');
  }
  if (!cargo) {
    console.log(`[DEBUG] Cargo nulo, sem permissão para setores`);
    return enviarMensagem(chatId, '⚠️ *Setores não disponíveis. Você não tem permissão. Contate o administrador.*');
  }
  const cargoNormalizado = cargo.toLowerCase();
  const keyboard = {
    inline_keyboard: []
  };
  if (cargoNormalizado === 'vendedor') {
    keyboard.inline_keyboard.push([{ text: '🛍️ Vendas', callback_data: 'setor_vendas' }]);
  } else if (cargoNormalizado === 'entregador') {
    keyboard.inline_keyboard.push([{ text: '🚚 Entrega', callback_data: 'setor_entrega' }]);
  } else {
    console.log(`[DEBUG] Cargo inválido: ${cargo}`);
    return null;
  }
  keyboard.inline_keyboard.push([{ text: '🛑 Sair', callback_data: 'sair' }]);
  return enviarMensagem(chatId, `ℹ️ *Bem-vindo(a) ao setor ${cargoNormalizado.toUpperCase()}! Escolha uma opção:*`, {
    reply_markup: keyboard
  });
};

// Função para solicitar o número de telefone
const solicitarNumeroTelefone = async (chatId) => {
  const keyboard = {
    keyboard: [[{ text: '📱 Compartilhar Número', request_contact: true }]],
    one_time_keyboard: true,
    resize_keyboard: true
  };
  try {
    await bot.sendMessage(chatId, '📲 *Por favor, compartilhe seu número de telefone para completar o cadastro.*', {
      reply_markup: keyboard
    });
  } catch (err) {
    console.error(`[ERROR] Erro ao solicitar número de telefone para ${chatId}:`, err.message);
    await enviarMensagem(chatId, '⚠️ *Erro ao solicitar número de telefone. Tente novamente.*');
  }
};

// Função para limpar mensagens do chat
const limparMensagensChat = async (chatId) => {
  try {
    console.log(`[DEBUG] Iniciando limpeza de mensagens para chatId: ${chatId}`);
    const sessao = sessoes.get(chatId) || { messageIds: [] };
    sessao.messageIds = sessao.messageIds || [];
    const tempMessage = await bot.sendMessage(chatId, '🧹 Iniciando limpeza...', { parse_mode: 'Markdown' });
    sessao.messageIds.push(tempMessage.message_id);
    let messageId = tempMessage.message_id;
    await bot.deleteMessage(chatId, tempMessage.message_id);
    let mensagensDeletadas = 0;
    let erros = 0;
    let mensagensAntigas = 0;
    let semPermissao = 0;
    const canDeleteOthers = await verificarPermissoes(chatId);
    console.log(`[DEBUG] Bot pode excluir mensagens de outros: ${canDeleteOthers}`);
    // Tentar excluir mensagens do cache primeiro
    const messageIds = [...new Set(sessao.messageIds)].sort((a, b) => b - a);
    for (const id of messageIds) {
      try {
        await bot.deleteMessage(chatId, id);
        mensagensDeletadas++;
        console.log(`[DEBUG] Mensagem ${id} deletada com sucesso.`);
      } catch (err) {
        erros++;
        if (err.message.includes('message to delete not found')) {
          console.log(`[DEBUG] Mensagem ${id} não encontrada.`);
        } else if (err.message.includes('message is too old')) {
          mensagensAntigas++;
          console.log(`[DEBUG] Mensagem ${id} muito antiga (>48h).`);
        } else if (err.message.includes('not enough rights')) {
          semPermissao++;
          console.log(`[DEBUG] Sem permissão para excluir mensagem ${id}.`);
        } else {
          console.error(`[ERROR] Erro ao deletar mensagem ${id}:`, err.message);
        }
      }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    // Continuar excluindo mensagens anteriores
    const maxTentativas = 10000; // Limite alto para tentar excluir o máximo
    let tentativa = 0;
    while (tentativa < maxTentativas && messageId > 1) {
      try {
        await bot.deleteMessage(chatId, messageId);
        mensagensDeletadas++;
        console.log(`[DEBUG] Mensagem ${messageId} deletada com sucesso.`);
      } catch (err) {
        erros++;
        if (err.message.includes('message to delete not found')) {
          console.log(`[DEBUG] Mensagem ${messageId} não encontrada.`);
        } else if (err.message.includes('message is too old')) {
          mensagensAntigas++;
          console.log(`[DEBUG] Mensagem ${messageId} muito antiga (>48h).`);
        } else if (err.message.includes('not enough rights')) {
          semPermissao++;
          console.log(`[DEBUG] Sem permissão para excluir mensagem ${messageId}.`);
        } else {
          console.error(`[ERROR] Erro ao deletar mensagem ${messageId}:`, err.message);
        }
      }
      messageId--;
      tentativa++;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    // Atualizar sessão
    sessao.messageIds = [];
    sessao.ultimaLimpeza = moment().format('YYYY-MM-DD HH:mm:ss');
    sessao.mensagensDeletadas = mensagensDeletadas;
    sessoes.set(chatId, sessao);
    // Montar feedback
    let feedback = `🧹 *Limpeza concluída!*\n- Mensagens deletadas: ${mensagensDeletadas}\n- Erros: ${erros}`;
    if (mensagensAntigas > 0) {
      feedback += `\n- Mensagens muito antigas (>48h): ${mensagensAntigas}`;
    }
    if (semPermissao > 0) {
      feedback += `\n- Sem permissão para excluir: ${semPermissao}`;
    }
    if (!canDeleteOthers) {
      feedback += `\n⚠️ *Nota*: O bot não tem permissão para excluir mensagens de outros usuários.`;
    }
    console.log(`[DEBUG] Limpeza concluída: ${mensagensDeletadas} mensagens deletadas, ${erros} erros, ${mensagensAntigas} antigas, ${semPermissao} sem permissão.`);
    return await bot.sendMessage(chatId, feedback, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error(`[ERROR] Erro ao limpar mensagens para ${chatId}:`, err.message);
    return await bot.sendMessage(chatId, `⚠️ *Erro ao limpar mensagens: ${err.message}*`, { parse_mode: 'Markdown' });
  }
};

// Função para executar queries com timeout
const queryWithTimeout = async (query, params, timeout = 5000) => {
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Query timeout')), timeout);
  });
  return Promise.race([
    db.query(query, params),
    timeoutPromise
  ]);
};

// Listener para capturar o número de telefone
bot.on('contact', async (msg) => {
  console.log('[DEBUG] Evento contact recebido:', JSON.stringify(msg, null, 2));
  const chatId = msg.chat?.id?.toString();
  const phoneNumber = msg.contact?.phone_number;
  if (!chatId || !phoneNumber) {
    console.error('[ERROR] Contato inválido:', { chatId, phoneNumber, msg });
    return enviarMensagem(chatId, '⚠️ *Número de telefone inválido. Tente novamente.*');
  }
  let sessao = sessoes.get(chatId) || {
    setor: null,
    data: moment().format('YYYY-MM-DD'),
    autenticado: false,
    logado: false,
    usuario_id: null,
    cargo: null,
    lastUpdated: Date.now(),
    messageIds: []
  };
  try {
    const [usuarios] = await queryWithTimeout('SELECT id FROM usuarios WHERE chat_id = ?', [chatId]);
    if (!usuarios.length) {
      console.error(`[ERROR] Usuário não encontrado para chatId ${chatId}`);
      return enviarMensagem(chatId, '⚠️ *Usuário não encontrado. Tente registrar novamente.*');
    }
    console.log(`[DEBUG] Atualizando número ${phoneNumber} para chatId ${chatId}`);
    const [result] = await queryWithTimeout('UPDATE usuarios SET numero = ? WHERE chat_id = ?', [phoneNumber, chatId]);
    console.log(`[DEBUG] Resultado da query:`, result);
    sessao.usuario_id = usuarios[0].id;
    sessao.lastUpdated = Date.now();
    sessoes.set(chatId, sessao);
    await enviarMensagem(chatId, `✅ *Número ${phoneNumber} salvo com sucesso!* Agora, envie sua *senha pessoal* (mínimo 4 caracteres).`);
  } catch (err) {
    console.error(`[ERROR] Erro ao salvar número de telefone para ${chatId}:`, err.message, err.stack);
    await enviarMensagem(chatId, '⚠️ *Erro ao salvar o número de telefone. Tente novamente.*');
  }
});

// Manipula mensagens (texto, fotos, etc.)
bot.on('message', async (msg) => {
  if (msg.contact) {
    console.log('[DEBUG] Ignorando mensagem de contato no manipulador de mensagem:', msg);
    return;
  }
  const chatId = msg.chat.id.toString();
  const hoje = moment().format('YYYY-MM-DD');
  let sessao = sessoes.get(chatId) || {
    setor: null,
    data: hoje,
    autenticado: false,
    logado: false,
    usuario_id: null,
    cargo: null,
    lastUpdated: Date.now(),
    messageIds: []
  };
  // Armazenar message_id da mensagem do usuário
  sessao.messageIds = sessao.messageIds || [];
  if (msg.message_id) {
    sessao.messageIds.push(msg.message_id);
    console.log(`[DEBUG] Mensagem do usuário ${msg.message_id} armazenada para chatId: ${chatId}`);
  }
  // Reseta sessão se for de outro dia
  if (sessao.data !== hoje) {
    sessao = {
      setor: null,
      data: hoje,
      autenticado: false,
      logado: false,
      usuario_id: null,
      cargo: null,
      lastUpdated: Date.now(),
      messageIds: []
    };
  }
  // Verifica timeout de sessão
  if (sessao.lastUpdated && Date.now() - sessao.lastUpdated > SESSION_TIMEOUT) {
    sessoes.delete(chatId);
    return enviarMensagem(chatId, '🕒 *Sessão expirada. Envie sua senha pessoal para continuar.*');
  }
  sessao.lastUpdated = Date.now();
  // Comando para limpar mensagens
  if (msg.text && msg.text.toLowerCase() === '/limpar') {
    if (!sessao.logado) {
      return enviarMensagem(chatId, '🔒 *Você precisa estar logado para usar o comando /limpar.* Envie sua senha pessoal.');
    }
    await limparMensagensChat(chatId);
    return;
  }
  // Consulta usuários
  let usuarios;
  try {
    [usuarios] = await queryWithTimeout('SELECT id, numero, senha, cargo, nome, ultima_sessao FROM usuarios WHERE chat_id = ?', [chatId]);
  } catch (err) {
    console.error(`[ERROR] Erro ao consultar usuários para ${chatId}:`, err.message);
    return enviarMensagem(chatId, '⚠️ *Erro ao acessar o sistema. Tente novamente.*');
  }
  // NOVO USUÁRIO
  if (!usuarios.length) {
    if (!msg.text || msg.text !== SENHA_MESTRE) {
      return enviarMensagem(chatId, '🔒 *Envie a senha de acesso para se registrar.*');
    }
    try {
      const [result] = await queryWithTimeout(
        'INSERT INTO usuarios (chat_id, senha, cargo, ultima_sessao, data_registro) VALUES (?, ?, ?, ?, ?)',
        [chatId, null, null, hoje, hoje]
      );
      sessao.usuario_id = result.insertId;
      sessao.cargo = null;
      sessao.lastUpdated = Date.now();
      sessoes.set(chatId, sessao);
      await solicitarNumeroTelefone(chatId);
      return enviarMensagem(chatId, '✅ *Acesso liberado!* Compartilhe seu número e envie sua senha pessoal para completar o cadastro.');
    } catch (err) {
      console.error(`[ERROR] Erro ao criar usuário para ${chatId}:`, err.message);
      return enviarMensagem(chatId, '⚠️ *Erro ao registrar usuário. Tente novamente.*');
    }
  }
  const usuario = usuarios[0];
  sessao.usuario_id = usuario.id;
  sessao.cargo = usuario.cargo;
  sessao.nome = usuario.nome;
  // USUÁRIO EXISTE MAS SEM SENHA
  if (!usuario.senha) {
    if (!usuario.numero) {
      await solicitarNumeroTelefone(chatId);
      return enviarMensagem(chatId, '❗ *Compartilhe seu número de telefone antes de definir a senha.*');
    }
    if (!msg.text || msg.text.length < 4) {
      return enviarMensagem(chatId, '❗ *A senha deve ter pelo menos 4 caracteres.*');
    }
    try {
      await queryWithTimeout(
        'UPDATE usuarios SET senha = SHA2(?, 256), ultima_sessao = ? WHERE chat_id = ?',
        [msg.text, hoje, chatId]
      );
      sessao.logado = true;
      sessao.lastUpdated = Date.now();
      sessoes.set(chatId, sessao);
      return enviarMenuSetores(chatId, sessao.cargo, enviarMensagem);
    } catch (err) {
      console.error(`[ERROR] Erro ao atualizar senha para ${chatId}:`, err.message);
      return enviarMensagem(chatId, '⚠️ *Erro ao salvar senha. Tente novamente.*');
    }
  }
  // VERIFICAÇÃO DE SENHA PESSOAL
  if (!sessao.logado) {
    if (!msg.text) {
      return enviarMensagem(chatId, '🔒 *Envie sua senha pessoal para acessar.*');
    }
    try {
      const [rows] = await queryWithTimeout(
        'SELECT id, cargo, nome FROM usuarios WHERE chat_id = ? AND senha = SHA2(?, 256)',
        [chatId, msg.text]
      );
      if (!rows.length) {
        return enviarMensagem(chatId, '❌ *Senha incorreta. Envie sua senha pessoal para acessar.*');
      }
      sessao.logado = true;
      sessao.cargo = rows[0].cargo;
      sessao.nome = rows[0].nome;
      sessao.lastUpdated = Date.now();
      sessoes.set(chatId, sessao);
      console.log(`[DEBUG] Usuário autenticado: chatId=${chatId}, nome=${sessao.nome || 'desconhecido'}, cargo=${sessao.cargo || 'nulo'}`);
      return enviarMensagem(chatId, `🔓 *Bem-vindo(a), ${sessao.nome || 'Usuário'}! Login diário realizado!*`, {
        reply_markup: { inline_keyboard: [[{ text: '➡️ Escolher Setor', callback_data: 'escolher_setor' }]] }
      });
    } catch (err) {
      console.error(`[ERROR] Erro ao verificar senha para ${chatId}:`, err.message);
      return enviarMensagem(chatId, '⚠️ *Erro ao verificar senha. Tente novamente.*');
    }
  }
  // AUTENTICAÇÃO DO SETOR
  if (sessao.setor && !sessao.autenticado) {
    if (!msg.text || !msg.text.trim()) {
      return enviarMensagem(chatId, `🔐 *Envie a senha do setor ${sessao.setor?.toUpperCase() || 'DESCONHECIDO'} para acessar.*`);
    }
    try {
      const [setores] = await queryWithTimeout(
        'SELECT senha_setor FROM setores WHERE nome_setor = ?',
        [sessao.setor]
      );
      if (!setores.length) {
        console.log(`[DEBUG] Setor inválido: ${sessao.setor}`);
        return enviarMensagem(chatId, '⚠️ *Setor inválido ou não configurado.*');
      }
      const senhaCorreta = await bcrypt.compare(msg.text, setores[0].senha_setor);
      if (!senhaCorreta) {
        return enviarMensagem(chatId, `🔐 *Senha incorreta. Envie a senha do setor ${sessao.setor?.toUpperCase() || 'DESCONHECIDO'} para acessar.*`);
      }
      sessao.autenticado = true;
      sessao.lastUpdated = Date.now();
      sessoes.set(chatId, sessao);
      const mensagem = sessao.cargo === null
        ? `✅ *Acesso ao setor ${sessao.setor.toUpperCase()} liberado.*\nℹ️ Seu cargo ainda não foi definido.`
        : `✅ *Acesso ao setor ${sessao.setor.toUpperCase()} liberado.*`;
      if (sessao.setor.toLowerCase() === 'entrega') {
        await enviarMensagem(chatId, mensagem);
        return await tratarEntrega('menu', msg, sessao, db, bot, chatId, sessoes, enviarMensagemPersistente);
      } else {
        return enviarBotaoSair(chatId, mensagem);
      }
    } catch (err) {
      console.error(`[ERROR] Erro ao autenticar setor ${sessao.setor} para ${chatId}:`, err.message);
      return enviarMensagem(chatId, '⚠️ *Erro ao autenticar setor. Tente novamente.*');
    }
  }
  // EXECUTA O FLUXO DO SETOR
  if (sessao.autenticado && sessao.setor) {
    try {
      switch (sessao.setor.toLowerCase()) {
        case 'vendas':
          return await tratarVendas(msg.text || '', msg, sessao, db, bot, enviarMensagem);
        case 'entrega':
          return await tratarEntrega(msg.text || '', msg, sessao, db, bot, chatId, sessoes, enviarMensagemPersistente);
        default:
          console.log(`[DEBUG] Setor desconhecido: ${sessao.setor}`);
          return enviarMenuSetores(chatId, sessao.cargo, enviarMensagem);
      }
    } catch (err) {
      console.error(`[ERROR] Erro no setor ${sessao.setor} para ${chatId}:`, err.message);
      return enviarMensagem(chatId, '⚠️ *Erro ao processar sua solicitação. Tente novamente.*');
    }
  }
  return enviarMenuSetores(chatId, sessao.cargo, enviarMensagem);
});

// Manipula cliques nos botões inline
bot.on('callback_query', async (query) => {
  const chatId = query.message?.chat?.id?.toString();
  const data = query.data;
  if (!chatId || !data) {
    console.error('[ERROR] Callback query inválida:', query);
    bot.answerCallbackQuery(query.id);
    return;
  }
  let sessao = sessoes.get(chatId) || {
    setor: null,
    data: moment().format('YYYY-MM-DD'),
    autenticado: false,
    logado: false,
    usuario_id: null,
    cargo: null,
    lastUpdated: Date.now(),
    messageIds: []
  };
  if (sessao.data !== moment().format('YYYY-MM-DD')) {
    sessao = {
      setor: null,
      data: moment().format('YYYY-MM-DD'),
      autenticado: false,
      logado: false,
      usuario_id: null,
      cargo: null,
      lastUpdated: Date.now(),
      messageIds: []
    };
  }
  try {
    if (sessao.setor === 'vendas' && sessao.autenticado) {
      bot.answerCallbackQuery(query.id);
      return await tratarVendas(query, { chat: { id: chatId } }, sessao, db, bot, sessoes, enviarMensagem);
    }
    if (sessao.setor === 'entrega' && sessao.autenticado) {
  console.log(`[DEBUG] Delegando callback ${data} para tratarEntrega`);
  bot.answerCallbackQuery(query.id);
  return await tratarEntrega(query, { chat: { id: chatId } }, sessao, db, bot, chatId, sessoes, enviarMensagemPersistente);
}
    if (data.startsWith('setor_')) {
      if (sessao.autenticado) {
        bot.answerCallbackQuery(query.id);
        return enviarMensagem(
          chatId,
          '⚠️ *Você já está autenticado em um setor. Clique em Sair para reiniciar.*',
          { reply_markup: { inline_keyboard: [[{ text: '🛑 Sair', callback_data: 'sair' }]] } }
        );
      }
      const setor = data.replace('setor_', '');
      if (!['vendas', 'entrega'].includes(setor)) {
        console.log(`[DEBUG] Setor inválido selecionado: ${setor}`);
        bot.answerCallbackQuery(query.id);
        return enviarMensagem(chatId, '⚠️ *Setor inválido. Escolha novamente.*');
      }
      const cargoNormalizado = sessao.cargo?.toLowerCase();
      if (
        (setor === 'vendas' && cargoNormalizado !== 'vendedor') ||
        (setor === 'entrega' && cargoNormalizado !== 'entregador')
      ) {
        console.log(`[DEBUG] Setor ${setor} não permitido para cargo ${sessao.cargo || 'nulo'}`);
        bot.answerCallbackQuery(query.id);
        return enviarMensagem(chatId, '⚠️ *Você não tem permissão para acessar este setor.*');
      }
      sessao.setor = setor;
      sessao.lastUpdated = Date.now();
      sessoes.set(chatId, sessao);
      bot.answerCallbackQuery(query.id);
      return enviarMensagem(
        chatId,
        `🔑 *Setor selecionado: ${sessao.setor.toUpperCase()}.*\nEnvie a senha do setor para continuar.`
      );
    }
    if (data === 'escolher_setor') {
      bot.answerCallbackQuery(query.id);
      return enviarMenuSetores(chatId, sessao.cargo, enviarMensagem);
    }
    if (data === 'sair') {
      sessoes.delete(chatId);
      bot.answerCallbackQuery(query.id);
      return enviarMensagem(chatId, '🛑 *Você saiu do fluxo.* Para começar, envie *oi* ou sua senha pessoal.');
    }
    bot.answerCallbackQuery(query.id);
    return enviarMensagem(chatId, '⚠️ *Ação inválida. Tente novamente.*');
  } catch (err) {
    console.error(`[ERROR] Erro ao processar callback para ${chatId}:`, err.message);
    bot.answerCallbackQuery(query.id);
    return enviarMensagem(chatId, '⚠️ *Erro ao processar ação. Tente novamente.*');
  }
});
