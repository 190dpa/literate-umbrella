require('dotenv').config();
const sgMail = require('@sendgrid/mail');
const express = require('express');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const http = require('http');
const { randomBytes } = require('crypto');
const { PrismaClient, Rarity, TicketStatus, AppealStatus, FriendshipStatus } = require('@prisma/client');
const { Server } = require("socket.io");

// --- Configuração do SendGrid ---
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// --- Configuração do Servidor Web ---
const app = express();
const prisma = new PrismaClient();

const server = http.createServer(app); // Criamos um servidor HTTP a partir do Express
const io = new Server(server); // Iniciamos o Socket.IO no mesmo servidor

app.use(bodyParser.json()); // Para entender requisições com corpo em JSON
app.use(bodyParser.urlencoded({ extended: true })); // Para entender formulários HTML

app.use(express.static('public')); // ✅ Permite que o servidor acesse arquivos na pasta 'public' (como músicas e imagens)

const port = process.env.PORT || 3000;

const PgStore = require('connect-pg-simple')(session);

// ⚙️ Confia no proxy HTTPS do Render (necessário para cookies funcionarem)
app.set('trust proxy', 1);

// --- Configuração da Sessão ---
// Criamos o middleware de sessão para poder compartilhá-lo com o Socket.IO
const sessionMiddleware = session({
    store: new PgStore({
        conString: `${process.env.DATABASE_URL}?sslmode=require`, // SSL para Render
        createTableIfMissing: true, // Cria a tabela de sessões automaticamente
    }),
    secret: process.env.SESSION_SECRET || 'um-segredo-muito-forte', // Crie uma SESSION_SECRET no seu .env
    resave: false,
    saveUninitialized: false,
    cookie: { 
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 dias
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production', // só exige HTTPS se em produção
  },
});

app.use(sessionMiddleware); // Usamos o middleware no Express
io.use((socket, next) => { // E também no Socket.IO
    sessionMiddleware(socket.request, {}, next);
});

// --- Rota de Cadastro (`/api/cadastrar`) ---
app.post('/api/cadastrar', async (req, res) => {
    const { username, email, password } = req.body;

    // Validação básica
    if (!username || !email || !password || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ message: 'Por favor, forneça um nome de usuário, e-mail válido e uma senha.' });
    }

    // Verifica se o usuário já existe (verificado ou pendente)
    const existingUser = await prisma.user.findUnique({ where: { email } });
    const pendingUser = await prisma.pendingUser.findUnique({ where: { email } });

    if (existingUser) {
        const message = existingUser.isBanned ? 'Esta conta foi banida.' : 'Este e-mail já está em uso por uma conta verificada.';
        return res.status(409).json({ message: message });
    }

    // Gera o código e hasheia a senha
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString(); // Gera um código de 6 dígitos
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    
    if (pendingUser) {
        // Se o usuário já está pendente, apenas atualiza o código e a senha
        await prisma.pendingUser.update({
            where: { email },
            data: { username, passwordHash, verificationCode }
        });
    } else {
        // Se não existe, cria um novo usuário pendente
        await prisma.pendingUser.create({ data: { email, username, passwordHash, verificationCode } });
    }

    // Configura o e-mail de verificação com o modelo bonito
    const bodyContent = `
        <p style="color: #b3b3b3; font-size: 16px; line-height: 24px; margin: 0 0 25px 0;">Olá, <strong>${username}</strong>!</p>
        <p style="color: #b3b3b3; font-size: 16px; line-height: 24px; margin: 0 0 35px 0;">Para completar seu cadastro no uberzer, por favor, use o código de 6 dígitos abaixo.</p>
        <style>
            @keyframes glow {
                0% { box-shadow: 0 0 5px #8e44ad, 0 0 10px #8e44ad; }
                50% { box-shadow: 0 0 20px #9b59b6, 0 0 30px #9b59b6; }
                100% { box-shadow: 0 0 5px #8e44ad, 0 0 10px #8e44ad; }
            }
            .code-box { animation: glow 2.5s infinite ease-in-out; }
        </style>
        <table border="0" cellpadding="0" cellspacing="0" width="100%">
            <tr>
                <td align="center" style="padding: 25px 0;">
                    <div class="code-box" style="background-color: #2a2a2a; border-radius: 8px; padding: 20px 30px; display: inline-block; border: 1px solid #444;">
                        <span style="color: #e0e0e0; font-size: 42px; letter-spacing: 15px; font-weight: 700; margin-left: 15px;">${verificationCode}</span>
                    </div>
                </td>
            </tr>
        </table>
        <p style="color: #b3b3b3; font-size: 16px; line-height: 24px; text-align: center; padding-top: 35px; margin: 0;">Volte para a página de verificação em nosso site e insira este código.</p>
    `;

    const emailHtml = createStyledEmail({
        title: 'Verifique sua Conta',
        bodyContent: bodyContent
    });

    const mailOptions = {
        from: { name: 'uberzer', email: process.env.EMAIL_USER },
        to: email,
        subject: 'Código de Verificação - uberzer',
        html: emailHtml
    };

    try {
        // Envia o e-mail em segundo plano, sem esperar pela resposta da SendGrid
        sgMail.send(mailOptions).catch(err => console.error("Erro ao enviar e-mail de verificação:", err));
        console.log(`E-mail de verificação enviado para ${email}`);
        res.status(200).json({ message: 'E-mail de verificação enviado! Por favor, verifique sua caixa de entrada.' });
    } catch (error) {
        // Este bloco catch agora é menos provável de ser atingido, mas é mantido por segurança.
        res.status(500).json({ message: 'Ocorreu um erro ao processar o cadastro.' });
    }
});

// --- Rota de Verificação (`/api/verificar`) ---
app.post('/api/verificar', async (req, res) => {
    // ✅ ADICIONADO: Bloco try...catch para evitar que o servidor trave em caso de erro.
    try {
        const { email, verificationCode } = req.body;

        if (!email || !verificationCode) {
            return res.status(400).json({ message: 'E-mail e código de verificação são obrigatórios.' });
        }

        const pendingUser = await prisma.pendingUser.findFirst({
            where: { email, verificationCode },
        });

        // Verifica se existe um cadastro pendente e se o código está correto
        if (pendingUser) {
            // Usamos uma transação para garantir que ambas as operações (criar usuário e deletar pendente) ocorram com sucesso.
            await prisma.$transaction(async (tx) => {
                // Verifica se um usuário com este e-mail já existe na tabela principal DENTRO da transação
                const existingUser = await tx.user.findUnique({ where: { email } });

                if (!existingUser) {
                    // Se o usuário não existe, cria um novo (o fluxo normal)
                    await tx.user.create({
                        data: {
                            email: pendingUser.email,
                            username: pendingUser.username,
                            passwordHash: pendingUser.passwordHash,
                            coins: 1000, // Dá 1000 moedas iniciais
                            health: 100, // Vida inicial
                        },
                    });
                }
                // Remove o usuário da tabela de pendentes, pois a verificação foi bem-sucedida
                await tx.pendingUser.delete({ where: { email } });
            });

            console.log(`Usuário ${email} verificado com sucesso!`);
            res.status(200).json({ message: '✅ E-mail verificado com sucesso! Agora você pode fazer login.' });

            // Envia e-mail de boas-vindas em segundo plano
            const welcomeEmailHtml = createStyledEmail({
                title: 'Bem-vindo ao uberzer!',
                bodyContent: `<p style="color: #b3b3b3; font-size: 16px; line-height: 24px;">Sua conta foi verificada com sucesso. Prepare-se para a aventura!</p>`
            });
            sgMail.send({ to: email, from: { name: 'uberzer', email: process.env.EMAIL_USER }, subject: 'Bem-vindo ao uberzer!', html: welcomeEmailHtml })
                .catch(err => console.error("Erro ao enviar e-mail de boas-vindas:", err));

        } else {
            res.status(400).json({ message: 'Código de verificação inválido ou expirado.' });
        }
    } catch (error) {
        console.error("Erro na rota /api/verificar:", error);
        res.status(500).json({ message: 'Ocorreu um erro interno ao verificar sua conta.' });
    }
});

// --- Rota de Login (`/api/login`) ---
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: 'E-mail e senha são obrigatórios.' });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    // 1. Verifica se o usuário existe
    if (!user) {
        return res.status(401).json({ message: 'Credenciais inválidas.' }); // 401 Unauthorized
    }

    // 2. Verifica se o usuário está banido (APÓS confirmar que ele existe)
    if (user.isBanned) {
        return res.status(403).json({ message: 'Esta conta foi banida.' }); // 403 Forbidden
    }

    // 2. Compara a senha enviada com o hash armazenado
    const isMatch = await bcrypt.compare(password, user.passwordHash);

    if (!isMatch) {
        return res.status(401).json({ message: 'Credenciais inválidas.' });
    }

    // 3. Se tudo estiver correto, cria a sessão
    req.session.user = {
        id: user.id,
        email: email,
        username: user.username,
        isAdmin: user.isAdmin
    };

    req.session.save((err) => {
        if (err) return res.status(500).json({ message: 'Não foi possível salvar a sessão.' });
        res.status(200).json({ message: 'Login bem-sucedido!', redirectTo: '/dashboard' });
    });
});

// --- Rota de Logout (`/api/logout`) ---
app.get('/api/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).json({ message: 'Não foi possível fazer logout.' });
        }
        res.redirect('/login');
    });
});

// --- Middleware para proteger rotas ---
async function isAuthenticated(req, res, next) {
    if (req.session.user) {
        try {
            const user = await prisma.user.findUnique({ where: { id: req.session.user.id } });
            if (user && !user.isBanned) {
                return next();
            } else {
                req.session.destroy(() => {
                    res.redirect('/login');
                });
            }
        } catch (error) {
            req.session.destroy(() => {
                res.redirect('/login');
            });
        }
    } else {
        res.redirect('/login');
    }
}

// --- Middleware para proteger rotas de Admin ---
function isAdmin(req, res, next) {
    if (req.session.user && req.session.user.isAdmin) {
        return next();
    }
    res.status(403).send('<h1>403 - Acesso Negado</h1>');
}

/**
 * Registra uma ação do administrador no banco de dados.
 * @param {string} adminUsername - O nome do admin que realizou a ação.
 * @param {string} action - O tipo da ação (ex: 'BAN_USER').
 * @param {string} details - Uma descrição detalhada da ação.
 */
async function logAdminAction(adminUsername, action, details) {
    try {
        await prisma.adminLog.create({
            data: { adminName: adminUsername, action, details },
        });
    } catch (error) {
        console.error("Falha ao registrar ação do admin:", error);
    }
}

// --- Módulo de Renderização de Páginas ---
// Centraliza todo o CSS e a estrutura HTML para um design coeso e fácil manutenção.

const mainStyleSheet = `
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap');
        :root {
            --bg-dark-primary: #121212; --bg-dark-secondary: #1e1e1e; --bg-dark-tertiary: #2a2a2a;
            --text-light-primary: #e0e0e0; --text-light-secondary: #b3b3b3;
            --accent-primary: #9b59b6; --accent-secondary: #8e44ad;
            --admin-accent: #f1c40f; --danger-accent: #e74c3c; --success-accent: #2ecc71; --info-accent: #3498db;
        }
        * { box-sizing: border-box; }
        body { font-family: 'Poppins', sans-serif; background-color: var(--bg-dark-primary); color: var(--text-light-primary); margin: 0; line-height: 1.6; }
        h1, h2 { color: var(--accent-primary); font-weight: 700; }
        a { color: var(--accent-primary); text-decoration: none; }
        a:hover { color: var(--accent-secondary); }
        
        /* --- Layout de Autenticação --- */
        .auth-layout { display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 20px; }
        .auth-container { background-color: var(--bg-dark-secondary); padding: 40px; border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,0.7); width: 100%; max-width: 420px; text-align: center; border-top: 4px solid var(--accent-primary); }
        .auth-container h1 { margin-top: 0; margin-bottom: 30px; }
        .form-group { margin-bottom: 20px; text-align: left; }
        .form-group label { display: block; margin-bottom: 8px; font-weight: 600; font-size: 0.9em; color: var(--text-light-secondary); }
        .form-group input, .form-group select, .form-group textarea { width: 100%; padding: 12px 15px; border-radius: 8px; border: 1px solid #444; background-color: var(--bg-dark-tertiary); color: var(--text-light-primary); font-size: 1em; font-family: 'Poppins', sans-serif; }
        .btn { display: inline-block; width: 100%; padding: 12px; border: none; border-radius: 8px; background-color: var(--accent-primary); color: #fff; font-size: 1.1em; font-weight: 600; cursor: pointer; transition: all 0.2s; }
        .btn:hover { background-color: var(--accent-secondary); transform: translateY(-2px); }
        .auth-link { margin-top: 25px; font-size: 0.9em; }
        .error-message { color: var(--danger-accent); margin-top: 15px; display: none; font-weight: 600; }

        /* --- Layout do Dashboard --- */
        .dashboard-layout { display: flex; }
        #sidebar { width: 260px; background-color: var(--bg-dark-secondary); height: 100vh; padding: 20px 0; position: fixed; left: -260px; transition: left 0.3s ease; z-index: 1000; display: flex; flex-direction: column; }
        #sidebar.open { left: 0; }
        #sidebar .sidebar-header { padding: 0 20px 20px 20px; font-size: 1.5em; font-weight: 700; color: var(--accent-primary); border-bottom: 1px solid #333; }
        #sidebar nav { flex-grow: 1; }
        #sidebar a { padding: 15px 20px; text-decoration: none; font-size: 1.1em; color: var(--text-light-secondary); display: block; transition: background-color 0.2s; border-left: 4px solid transparent; }
        #sidebar a:hover { background-color: var(--bg-dark-tertiary); color: var(--text-light-primary); }
        #sidebar a.active { border-left-color: var(--accent-primary); color: var(--text-light-primary); font-weight: 600; }
        #sidebar .sidebar-footer { padding: 20px; border-top: 1px solid #333; }
        #main-content { flex-grow: 1; padding: 30px; margin-left: 0; transition: margin-left 0.3s ease; }
        #main-content.shifted { margin-left: 260px; }
        #menu-toggle { font-size: 24px; cursor: pointer; background: var(--bg-dark-tertiary); color: white; border: none; padding: 10px 15px; position: fixed; top: 15px; left: 15px; z-index: 1001; border-radius: 8px; }

        /* --- Componentes Gerais --- */
        .card { background: var(--bg-dark-secondary); padding: 20px; border-radius: 12px; margin-bottom: 20px; }
        .char-card { background: var(--bg-dark-secondary); padding: 15px; border-radius: 8px; border-left: 5px solid; transition: transform 0.2s; }
        .char-card:hover { transform: translateY(-5px); }
        .char-rarity { font-weight: bold; font-size: 0.9em; margin-bottom: 5px; }
        .char-name { font-size: 1.2em; font-weight: 600; }
        .char-ability { font-size: 0.9em; color: var(--text-light-secondary); margin-top: 10px; }
        .characters-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 20px; margin-top: 20px; }
        
        /* --- Painel de Admin --- */
        .admin-section { margin-bottom: 40px; }
        .admin-section h2 { border-bottom: 2px solid var(--admin-accent); padding-bottom: 10px; color: var(--admin-accent); }
        .user-list { list-style: none; padding: 0; }
        .user-list-item { background: var(--bg-dark-tertiary); padding: 15px; margin-bottom: 10px; border-radius: 8px; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 15px; }
        .user-list-item a { color: var(--text-light-primary); text-decoration: none; display: block; width: 100%; }
        .user-list-item a:hover { background-color: rgba(255,255,255,0.05); }
        .ticket-link { color: var(--text-light-primary); text-decoration: none; }
        .ticket-link:hover { text-decoration: underline; }

        /* --- Chat do Ticket --- */
        .message-bubble { padding: 10px 15px; border-radius: 18px; margin-bottom: 10px; max-width: 70%; word-wrap: break-word; }
        .user-message { background-color: var(--accent-primary); color: white; margin-left: auto; border-bottom-right-radius: 4px; }
        .admin-message { background-color: var(--bg-dark-tertiary); color: var(--text-light-primary); margin-right: auto; border-bottom-left-radius: 4px; }
        .user-info { font-weight: 600; }
        .user-info span { font-weight: 400; color: var(--text-light-secondary); font-size: 0.9em; }
        .admin-form { display: flex; align-items: center; gap: 10px; }
        .admin-form input { padding: 8px; }
        .admin-form .btn-small { padding: 8px 12px; font-size: 0.9em; width: auto; }
        .btn-danger { background-color: var(--danger-accent); } .btn-danger:hover { background-color: #c0392b; }
        .btn-success { background-color: var(--success-accent); } .btn-success:hover { background-color: #27ae60; }
        .btn-info { background-color: var(--info-accent); } .btn-info:hover { background-color: #2980b9; }
        .btn-special { background: linear-gradient(45deg, var(--admin-accent), #ff7043); color: #111; } .btn-special:hover { filter: brightness(1.2); }

        /* --- Animações --- */
        #fight-animation { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: #111; z-index: 2000; display: none; justify-content: center; align-items: center; overflow: hidden; }
        .side { position: absolute; width: 50%; height: 100%; background-size: cover; transition: transform 0.5s cubic-bezier(0.8, 0, 0.2, 1); }
        #left-side { left: 0; background-color: var(--accent-primary); transform: translateX(-100%); }
        #right-side { right: 0; background-color: var(--danger-accent); transform: translateX(100%); }
        #vs { position: absolute; font-size: 15vw; color: white; font-weight: bold; text-shadow: 0 0 20px black; transform: scale(3); opacity: 0; transition: all 0.3s ease-out 0.4s; }
        #fight-animation.active #left-side, #fight-animation.active #right-side { transform: translateX(0); }
        #fight-animation.active #vs { transform: scale(1); opacity: 1; }

        #roll-animation-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 2000; display: none; justify-content: center; align-items: center; backdrop-filter: blur(5px); }
        #roll-animation-overlay.active { display: flex; }
        #roll-card { transform: scale(0); transition: transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1); }
        #roll-animation-overlay.reveal #roll-card { transform: scale(1); }
        @keyframes chaty-glow { 0%, 100% { box-shadow: 0 0 20px 10px var(--admin-accent), 0 0 30px 15px #fff; } 50% { box-shadow: 0 0 40px 20px var(--admin-accent), 0 0 60px 30px #fff; } }
        #roll-animation-overlay.is-chatynirares { background: radial-gradient(circle, rgba(241,196,15,0.3) 0%, rgba(0,0,0,0.8) 70%); }
        #roll-animation-overlay.is-chatynirares #roll-card { animation: chaty-glow 2s infinite; }
    </style>
    <style>
        /* --- Estilos da Nova Página de Luta --- */
        .battle-arena { display: flex; justify-content: space-around; align-items: flex-end; gap: 20px; background: var(--bg-dark-tertiary); padding: 20px; border-radius: 12px; min-height: 400px; }
        .fighter { text-align: center; width: 250px; position: relative; }
        .fighter-sprite { width: 128px; height: 128px; background: var(--bg-dark-primary); border: 3px solid #444; border-radius: 8px; margin: 0 auto 10px; image-rendering: pixelated; /* Para sprites pixel art */ }
        .fighter-name { font-size: 1.5em; font-weight: bold; }
        .health-bar-container { background: #111; border-radius: 5px; padding: 3px; margin-top: 5px; }
        .health-bar { height: 20px; border-radius: 3px; transition: width 0.5s ease-in-out; }
        #player-health-bar { background: linear-gradient(to right, #2ecc71, #27ae60); }
        #opponent-health-bar { background: linear-gradient(to right, #e74c3c, #c0392b); }
        .health-text { font-size: 0.9em; font-weight: 600; color: white; margin-top: 5px; }
        #battle-actions { text-align: center; margin-top: 20px; }
        #battle-actions .btn { width: auto; margin: 5px; }
        .damage-popup { position: absolute; top: 20%; left: 50%; transform: translateX(-50%); font-size: 2em; font-weight: bold; color: #ffeb3b; text-shadow: 2px 2px #000; animation: floatUp 1s forwards; pointer-events: none; }
        @keyframes floatUp { from { top: 20%; opacity: 1; } to { top: -20%; opacity: 0; } }
        @keyframes shake {
            0%, 100% { transform: translateX(0); } 25% { transform: translateX(-5px); } 50% { transform: translateX(5px); } 75% { transform: translateX(-5px); }
        }
        .shake-anim { animation: shake 0.3s; }
        @keyframes disintegrate {
            0%, 100% { transform: translateX(0); }
            25% { transform: translateX(-5px); }
            50% { transform: translateX(5px); }
            75% { transform: translateX(-5px); }
        }
        .shake-anim { animation: shake 0.3s; }

        /* --- Animações de Despertar --- */
        #awakening-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: #000; z-index: 3000; display: none; justify-content: center; align-items: center; text-align: center; font-family: 'VT323', monospace; }
        .awakening-line { font-size: 5vw; line-height: 1.2; text-shadow: 0 0 5px #ff00ff, 0 0 10px #ff00ff, 0 0 20px #ff00ff, 0 0 40px #00ffff, 0 0 60px #00ffff; opacity: 0; animation: fadeIn 0.1s forwards, glitch 1.5s infinite; }
        @keyframes fadeIn { to { opacity: 1; } }
        @keyframes glitch { 0%, 100% { transform: skewX(0); } 50% { transform: skewX(20deg); opacity: 0.8; } }
        .overlord-aura { position: absolute; width: 200px; height: 200px; border-radius: 50%; background: radial-gradient(circle, rgba(255,255,255,0.5) 0%, rgba(255,255,255,0) 70%); animation: pulse 1s infinite; }
        @keyframes pulse { 0% { transform: scale(1); opacity: 0.7; } 50% { transform: scale(1.2); opacity: 1; } 100% { transform: scale(1); opacity: 0.7; } }
        .lightning { position: absolute; width: 4px; height: 100px; background: white; transform-origin: top; animation: lightning-strike 0.2s linear; }
        @keyframes lightning-strike { 0% { transform: scaleY(0); } 50% { transform: scaleY(1); } 100% { transform: scaleY(0); transform-origin: bottom; } }
        @keyframes rgb-border { 0% { box-shadow: inset 0 0 20px #ff0000; } 33% { box-shadow: inset 0 0 20px #00ff00; } 66% { box-shadow: inset 0 0 20px #0000ff; } 100% { box-shadow: inset 0 0 20px #ff0000; } }
        .awakening-active { animation: rgb-border 2s linear infinite; }
        /* Efeito de Despertar do Overlord */
        @keyframes bw-pulse-border { 0% { box-shadow: inset 0 0 15px #ffffff; } 50% { box-shadow: inset 0 0 25px #555555, inset 0 0 35px #000000; } 100% { box-shadow: inset 0 0 15px #ffffff; } }
        .overlord-awakening-active { animation: bw-pulse-border 1.5s ease-in-out infinite; }
        /* Efeito de Despertar do Rato Maromba */
        @keyframes gym-spotlight-border { 0% { box-shadow: inset 0 0 20px #f1c40f; } 50% { box-shadow: inset 0 0 30px #f39c12, inset 0 0 15px #fff; } 100% { box-shadow: inset 0 0 20px #f1c40f; } }
        .rat-awakening-active { animation: gym-spotlight-border 1s ease-in-out infinite; }

        /* Efeito de Sangue para o Jacket */
        .blood-particle { position: absolute; width: 8px; height: 8px; background-color: var(--danger-accent); border-radius: 50%; animation: blood-fade 0.6s forwards; }
        @keyframes blood-fade { to { transform: scale(0); opacity: 0; } }

        /* --- Sistema de Notificação --- */
        #notification-container { position: fixed; top: 20px; right: 20px; z-index: 9999; display: flex; flex-direction: column; gap: 10px; }
        .notification {
            background-color: var(--bg-dark-tertiary); color: var(--text-light-primary);
            padding: 15px 20px; border-radius: 8px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.5);
            display: flex; align-items: center; gap: 15px;
            min-width: 300px; max-width: 400px;
            border-left: 5px solid var(--info-accent);
            transform: translateX(120%);
            animation: slideIn 0.5s forwards;
        }
        .notification.success { border-left-color: var(--success-accent); }
        .notification.error { border-left-color: var(--danger-accent); }
        .notification.exiting { animation: slideOut 0.5s forwards; }
        .notification-message { flex-grow: 1; }
        .notification-close { background: none; border: none; color: var(--text-light-secondary); font-size: 20px; cursor: pointer; line-height: 1; padding: 0; }
        .notification-close:hover { color: var(--text-light-primary); }

        @keyframes slideIn { to { transform: translateX(0); } }
        @keyframes slideOut { to { transform: translateX(120%); } }

        /* --- Estilos da Lista de Amigos --- */
        .friend-list-pfp { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; margin-right: 15px; }
        .user-list-item > span { flex-grow: 1; }

    </style>
`;

const banHandlerScript = `
    <script>
        socket.on('banned', (data) => {
            const reason = data.reason || 'Nenhum motivo especificado.';
            const escapedReason = reason.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            document.body.innerHTML = \`<div style="display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; background-color: #121212; color: #f0f0f0; text-align: center; padding: 20px;"><h1 style="color: #e53935; margin-bottom: 20px;">Você foi banido.</h1><p style="font-size: 1.2em;">Motivo: \${escapedReason}</p></div>\`;
        });
    </script>
`;

/**
 * Cria o HTML para um e-mail estilizado padrão.
 * @param {object} options
 * @param {string} options.title - O título principal no cabeçalho do e-mail.
 * @param {string} options.bodyContent - O conteúdo HTML principal do corpo do e-mail.
 * @param {object} [options.button] - Objeto opcional para um botão de ação.
 * @param {string} options.button.text - O texto do botão.
 * @param {string} options.button.link - O URL para onde o botão aponta.
 * @returns {string} O HTML completo da página.
 */
function createStyledEmail({ title, bodyContent, button }) {
    const buttonHtml = button
        ? `<tr>
            <td style="padding: 20px 0 30px 0;" align="center">
              <table border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center" style="border-radius: 8px;" bgcolor="#9b59b6">
                    <a href="${button.link}" target="_blank" style="font-size: 16px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px; padding: 14px 28px; border: 1px solid #9b59b6; display: inline-block;">${button.text}</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`
        : '';

    return `<!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${title}</title>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap');
          body { margin: 0; padding: 0; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
          table, td { border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
          img { border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
          p { display: block; margin: 13px 0; }
        </style>
      </head>
      <body style="background-color: #111111;">
        <table border="0" cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td valign="top" style="padding: 40px 20px;">
              <table align="center" border="0" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%; background-color: #1c1c1c; border-radius: 12px; overflow: hidden;">
                <!-- Header -->
                <tr>
                  <td align="center" style="padding: 40px 30px 20px 30px; background: linear-gradient(to bottom, #2a2a2a, #1c1c1c);">
                    <h1 style="font-family: 'Poppins', sans-serif; font-size: 28px; font-weight: 700; color: #f0f0f0; margin: 0;">uberzer</h1>
                    <p style="font-family: 'Poppins', sans-serif; font-size: 18px; font-weight: 400; color: #9b59b6; margin: 5px 0 0 0;">${title}</p>
                  </td>
                </tr>
                <!-- Body -->
                <tr>
                  <td style="padding: 0 30px 20px 30px; font-family: 'Poppins', sans-serif; font-size: 16px; line-height: 1.7; color: #b3b3b3;">
                    ${bodyContent}
                  </td>
                </tr>
                <!-- Button -->
                ${buttonHtml}
                <!-- Footer -->
                <tr>
                  <td align="center" style="padding: 20px 30px; background-color: #111111; border-top: 1px solid #333;">
                    <p style="font-family: 'Poppins', sans-serif; color: #888888; font-size: 12px; margin: 0;">Se você não solicitou esta ação, pode ignorar este e-mail.</p>
                    <p style="font-family: 'Poppins', sans-serif; color: #888888; font-size: 12px; margin: 10px 0 0 0;">© 2024 uberzer. Todos os direitos reservados.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>`;
}

/**
 * Renderiza uma página de autenticação padrão.
 * @param {string} title - O título da página.
 * @param {string} content - O conteúdo HTML do corpo da página.
 * @returns {string} O HTML completo da página.
 */
function renderAuthPage(title, content) {
    return `<!DOCTYPE html>
    <html lang="pt-BR">
    <head><meta charset="UTF-8"><title>${title} - uberzer</title>${mainStyleSheet}</head>
    <body><div class="auth-layout">${content}</div></body>
    </html>`;
}

/**
 * Renderiza uma página do dashboard com a sidebar.
 * @param {object} session - A sessão do usuário.
 * @param {string} title - O título da página.
 * @param {string} content - O conteúdo HTML da área principal.
 * @returns {string} O HTML completo da página.
 */
function renderDashboardPage(session, title, content, pageScript = '') {
    const { username, isAdmin } = session.user;
    const sidebar = `
        <div id="sidebar">
            <div class="sidebar-header">uberzer</div>
            <nav>
                <a href="/dashboard">Dashboard</a>
                <a href="/settings">Configurações</a>
                <a href="/status">Status & Nível</a>
                <a href="/friends">Amigos</a>
                <a href="/multiplayer-fight">Luta Multiplayer</a>
                <a href="/chat">Chat Global</a>
                <a href="/tickets">Suporte</a>
                <a href="/fight">Lutar (+50 Moedas)</a>
                <a href="/swords">Estoque de Espadas</a>
                <a href="/characters">Meus Personagens</a>
                ${isAdmin ? '<a href="/admin" style="color: var(--admin-accent);">Admin Panel</a>' : ''}
            </nav>
            <div class="sidebar-footer">
                <a href="/api/logout">Sair</a>
            </div>
        </div>`;

    return `<!DOCTYPE html>
    <html lang="pt-BR">
    <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title} - uberzer</title>${mainStyleSheet}</head>
    <body>
        <div class="dashboard-layout">
            ${sidebar}
            <div id="notification-container"></div>
            <main id="main-content">
                <button id="menu-toggle">&#9776;</button>
                ${content}
            </main>
        </div>
        <script src="/socket.io/socket.io.js"></script>
        <script>
            const menuToggle = document.getElementById('menu-toggle');
            const sidebar = document.getElementById('sidebar');
            const mainContent = document.getElementById('main-content');
            const socket = io();
            menuToggle.addEventListener('click', () => {
                sidebar.classList.toggle('open');
                mainContent.classList.toggle('shifted');
            });

            function showNotification(message, type = 'info') {
                const container = document.getElementById('notification-container');
                const notification = document.createElement('div');
                notification.className = 'notification ' + type;
                notification.innerHTML = \`
                    <div class="notification-message">\${message}</div>
                    <button class="notification-close">&times;</button>
                \`;
                container.appendChild(notification);

                const close = () => {
                    notification.classList.add('exiting');
                    setTimeout(() => notification.remove(), 500);
                };

                notification.querySelector('.notification-close').addEventListener('click', close);
                setTimeout(close, 5000); // Fecha automaticamente após 5 segundos
            }

            socket.on('friend_request', (data) => {
                showNotification(\`Você recebeu um pedido de amizade de \${data.from}!\`, 'info');
            });

            ${pageScript}
        </script>
        ${banHandlerScript}
    </body>
    </html>`;
}

// --- Página de Cadastro (Formulário) ---
app.get('/register', (req, res) => {
    if (req.session.user) {
        return res.redirect('/dashboard');
    }
    const content = `
        <div class="auth-container">
            <h1>Criar Conta</h1>
            <form id="register-form">
                <div class="form-group">
                    <label for="username">Nome de Usuário</label>
                    <input type="text" id="username" name="username" required>
                </div>
                <div class="form-group">
                    <label for="email">Email</label>
                    <input type="email" id="email" name="email" required>
                </div>
                <div class="form-group">
                    <label for="password">Senha</label>
                    <input type="password" id="password" name="password" required>
                </div>
                <button type="submit" class="btn">Cadastrar</button>
                <p id="error-message" class="error-message"></p>
            </form>
            <div class="auth-link">Já tem uma conta? <a href="/login">Faça login</a></div>
        </div>
        <script>
            document.getElementById('register-form').addEventListener('submit', async (e) => {
                e.preventDefault();
                const username = e.target.username.value;
                const email = e.target.email.value;
                const password = e.target.password.value;
                const errorMessage = document.getElementById('error-message');

                const response = await fetch('/api/cadastrar', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, email, password })
                });

                const data = await response.json();
                if (!response.ok) {
                    errorMessage.textContent = data.message || 'Erro no servidor (' + response.status + '). Tente novamente.';
                    errorMessage.style.display = 'block';
                    return;
                }

                if (data.message.includes('enviado')) { // Sucesso
                    window.location.href = '/verify?email=' + encodeURIComponent(email);
                } else {
                    errorMessage.textContent = data.message;
                    errorMessage.style.display = 'block';
                }
            });
        </script>
    `;
    res.send(renderAuthPage('Cadastro', content));
});

// --- Página de Verificação (Formulário) ---
app.get('/verify', (req, res) => {
    const email = req.query.email;
    if (!email) {
        return res.redirect('/register');
    }
    const content = `
        <div class="auth-container">
            <h1>Verifique seu Email</h1>
            <p style="color: #aaa; margin-bottom: 20px;">Enviamos um código de 6 dígitos para <strong>${email}</strong>. Insira-o abaixo.</p>
            <form id="verify-form">
                <div class="form-group">
                    <label for="code">Código de Verificação</label>
                    <input type="text" id="code" name="code" required maxlength="6" pattern="[0-9]{6}" inputmode="numeric">
                </div>
                <button type="submit" class="btn">Verificar</button>
                <p id="error-message" class="error-message"></p>
            </form>
        </div>
        <script>
            document.getElementById('verify-form').addEventListener('submit', async (e) => {
                e.preventDefault();
                const code = e.target.code.value;
                const email = "${email}";
                const errorMessage = document.getElementById('error-message');

                const response = await fetch('/api/verificar', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, verificationCode: code })
                });

                const data = await response.json();
                if (!response.ok) {
                    errorMessage.textContent = data.message || 'Erro no servidor (' + response.status + '). Tente novamente.';
                    errorMessage.style.display = 'block';
                    return;
                }

                if (data.message.includes('sucesso')) {
                    showNotification('Conta verificada com sucesso! Redirecionando para o login...', 'success');
                    window.location.href = '/login';
                } else {
                    errorMessage.textContent = data.message;
                    errorMessage.style.display = 'block';
                }
            });
        </script>
    `;
    res.send(renderAuthPage('Verificação', content));
});

// --- Página de Login (Formulário) ---
app.get('/login', (req, res) => {
    // Se já estiver logado, redireciona para o dashboard
    if (req.session.user) {
        return res.redirect('/dashboard');
    }
    const content = `
        <div class="auth-container">
            <h1 style="color: var(--accent-primary); font-size: 2.5em; margin-bottom: 5px; letter-spacing: 2px;">uberzer</h1>
            <p style="color: #aaa; margin-top: 0; margin-bottom: 30px;">[o mundo rpg legal]</p>
            <h2 style="font-weight: 600; color: var(--text-light-secondary);">Login</h2>
            <form id="login-form">
                <div class="form-group">
                    <label for="email">Email</label>
                    <input type="email" id="email" name="email" required autocomplete="email">
                </div>
                <div class="form-group">
                    <label for="password">Senha</label>
                    <input type="password" id="password" name="password" required autocomplete="current-password">
                </div>
                <button type="submit" class="btn">Entrar</button>
                <p id="error-message" class="error-message"></p>
            </form>
            <div class="auth-link" style="display: flex; justify-content: space-between;">
                <a href="/forgot-password">Esqueceu a senha?</a>
                <span>Não tem uma conta? <a href="/register">Cadastre-se</a></span>
            </div>
        </div>
        <script>
            document.getElementById('login-form').addEventListener('submit', async (e) => {
                e.preventDefault();
                const email = e.target.email.value;
                const password = e.target.password.value;
                const errorMessage = document.getElementById('error-message');

                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });

                const data = await response.json().catch(() => null);

                if (!response.ok) {
                    errorMessage.textContent = data?.message || 'Erro no servidor (' + response.status + ').';
                    errorMessage.style.display = 'block';
                    return;
                }

                if (data && data.redirectTo) {
                    window.location.href = data.redirectTo;
                } else {
                    errorMessage.textContent = 'Ocorreu um erro inesperado.';
                    errorMessage.style.display = 'block';
                }
            });
        </script>
    `;
    res.send(renderAuthPage('Login', content));
});

// --- Página e API para Recuperação de Conta ---

// 1. Página para solicitar a recuperação
app.get('/forgot-password', (req, res) => {
    const content = `
        <div class="auth-container">
            <h1>Recuperar Conta</h1>
            <p style="color: #aaa; margin-bottom: 20px;">Insira seu e-mail e enviaremos um link para você redefinir sua senha.</p>
            <form id="forgot-form">
                <div class="form-group">
                    <label for="email">Email</label>
                    <input type="email" id="email" name="email" required>
                </div>
                <button type="submit" class="btn">Enviar Link de Recuperação</button>
                <p id="message" class="error-message" style="color: var(--success-accent);"></p>
            </form>
        </div>
        <script>
            document.getElementById('forgot-form').addEventListener('submit', async (e) => {
                e.preventDefault();
                const email = e.target.email.value;
                const messageEl = document.getElementById('message');
                
                const response = await fetch('/api/forgot-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email })
                });

                const data = await response.json();
                if (!response.ok) {
                    messageEl.textContent = data.message || 'Erro no servidor (' + response.status + ').';
                    return;
                }

                messageEl.textContent = data.message;
                messageEl.style.display = 'block';
            });
        </script>
    `;
    res.send(renderAuthPage('Recuperar Conta', content));
});

// 2. API para processar a solicitação e enviar o e-mail
app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!await prisma.user.findUnique({ where: { email } })) {
        // Responde com sucesso mesmo que o e-mail não exista para não revelar quais e-mails estão cadastrados
        return res.status(200).json({ message: 'Se um usuário com este e-mail existir, um link de recuperação foi enviado.' });
    }

    const token = randomBytes(32).toString('hex');
    const expires = Date.now() + 3600000; // 1 hora de validade
    await prisma.passwordReset.create({ data: { email, token, expires: new Date(expires) } });

    const resetLink = `${process.env.BASE_URL || `http://localhost:${port}`}/reset-password?token=${token}`;

    const emailHtml = createStyledEmail({
        title: 'Redefinição de Senha',
        bodyContent: `<p style="color: #b3b3b3; font-size: 16px; line-height: 24px;">Você solicitou uma redefinição de senha. Clique no botão abaixo para criar uma nova senha. Se você não fez esta solicitação, pode ignorar este e-mail.</p>`,
        button: { text: 'Redefinir Senha', link: resetLink }
    });

    const mailOptions = {
        to: email,
        from: { name: 'Suporte uberzer', email: process.env.EMAIL_USER },
        subject: 'Redefinição de Senha - uberzer',
        html: emailHtml
    };

    try {
        await sgMail.send(mailOptions);
        res.status(200).json({ message: 'Se um usuário com este e-mail existir, um link de recuperação foi enviado.' });
    } catch (error) {
        console.error('Erro ao enviar e-mail de recuperação:', error);
        res.status(500).json({ message: 'Erro ao enviar e-mail.' });
    }
});

// 3. Página para redefinir a senha
app.get('/reset-password', async (req, res) => {
    const { token } = req.query;
    const resetData = await prisma.passwordReset.findUnique({ where: { token } });

    if (!resetData || resetData.expires < new Date()) {
        return res.status(400).send('<h1>Token inválido ou expirado.</h1><p>Por favor, solicite um novo link de recuperação.</p>');
    }

    const content = `
        <div class="auth-container">
            <h1>Crie uma Nova Senha</h1>
            <form action="/api/reset-password" method="POST">
                <input type="hidden" name="token" value="${token}">
                <div class="form-group">
                    <label for="password">Nova Senha</label>
                    <input type="password" id="password" name="password" required>
                </div>
                <button type="submit" class="btn">Salvar Nova Senha</button>
            </form>
        </div>
    `;
    res.send(renderAuthPage('Redefinir Senha', content));
});

// 4. API para salvar a nova senha
app.post('/api/reset-password', async (req, res) => {
    const { token, password } = req.body;
    const resetData = await prisma.passwordReset.findFirst({
        where: { token, expires: { gte: new Date() } }
    });

    if (!resetData) {
        return res.status(400).send('Token inválido ou expirado.');
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    await prisma.user.update({ where: { email: resetData.email }, data: { passwordHash } });

    await prisma.passwordReset.delete({ where: { token } }); // Invalida o token após o uso
    res.redirect('/login');
});

// --- Página do Dashboard (Protegida) ---
app.get('/dashboard', isAuthenticated, async (req, res) => {
  try {
    // Recarrega os dados do usuário para exibir informações atualizadas
    const user = await prisma.user.findUnique({
      where: { id: req.session.user.id },
      select: { username: true, coins: true, isAdmin: true }
    });

    if (!user) {
      req.session.destroy(() => res.redirect('/login'));
      return;
    }

    // Conteúdo do painel (pode editar à vontade)
    const content = `
      <div class="card">
        <h1>Bem-vindo, ${user.username}!</h1>
        <p>💰 Você tem <strong>${user.coins}</strong> moedas.</p>
      </div>
      <div class="card">
        <p>Use o menu à esquerda para navegar.</p>
      </div>
    `;

    // Renderiza com a sidebar e o layout bonito
    res.send(renderDashboardPage(req.session, 'Dashboard', content));

  } catch (err) {
    console.error('Erro ao renderizar dashboard:', err);
    res.status(500).send('<h1>Erro interno ao carregar o dashboard.</h1>');
  }
});

// --- PÁGINA E API DE CONFIGURAÇÕES ---

app.get('/settings', isAuthenticated, async (req, res) => {
    const user = await prisma.user.findUnique({
        where: { id: req.session.user.id },
        select: { username: true, email: true, profilePictureUrl: true }
    });

    const profilePic = user.profilePictureUrl || 'https://via.placeholder.com/128?text=No+Image';

    const content = `
        <style>
            .profile-pic { width: 128px; height: 128px; border-radius: 50%; object-fit: cover; border: 4px solid var(--accent-primary); margin-bottom: 20px; }
        </style>
        <h1>Configurações da Conta</h1>
        <div class="card" style="text-align: center;">
            <img src="${profilePic}" alt="Foto de Perfil" class="profile-pic">
            <h2>${user.username}</h2>
            <p>${user.email}</p>
        </div>

        <div class="admin-section">
            <h2>Alterar Foto de Perfil</h2>
            <div class="card">
                <form id="pfp-form">
                    <div class="form-group">
                        <label for="pfp-url">URL da Imagem</label>
                        <input type="url" id="pfp-url" name="url" placeholder="https://exemplo.com/imagem.png" required>
                    </div>
                    <button type="submit" class="btn">Salvar Foto</button>
                </form>
            </div>
        </div>

        <div class="admin-section">
            <h2>Alterar Nome de Usuário</h2>
            <div class="card">
                <form id="username-form">
                    <div class="form-group">
                        <label for="new-username">Novo Nome de Usuário</label>
                        <input type="text" id="new-username" name="username" required>
                    </div>
                    <button type="submit" class="btn">Salvar Nome</button>
                </form>
            </div>
        </div>

        <div class="admin-section">
            <h2>Alterar Senha</h2>
            <div class="card">
                <form id="password-form">
                    <div class="form-group">
                        <label for="current-password">Senha Atual</label>
                        <input type="password" id="current-password" name="currentPassword" required>
                    </div>
                    <div class="form-group">
                        <label for="new-password">Nova Senha</label>
                        <input type="password" id="new-password" name="newPassword" required>
                    </div>
                    <button type="submit" class="btn">Salvar Senha</button>
                </form>
            </div>
        </div>
    `;

    const pageScript = `
        async function handleFormSubmit(formId, url, successMessage) {
            document.getElementById(formId).addEventListener('submit', async (e) => {
                e.preventDefault();
                const formData = new FormData(e.target);
                const data = Object.fromEntries(formData.entries());

                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });

                const result = await response.json();
                if (response.ok) {
                    showNotification(successMessage, 'success');
                    setTimeout(() => window.location.reload(), 1500);
                } else {
                    showNotification(result.message, 'error');
                }
            });
        }

        handleFormSubmit('pfp-form', '/api/settings/profile-picture', 'Foto de perfil atualizada com sucesso!');
        handleFormSubmit('username-form', '/api/settings/username', 'Nome de usuário atualizado com sucesso!');
        handleFormSubmit('password-form', '/api/settings/password', 'Senha alterada com sucesso!');
    `;

    res.send(renderDashboardPage(req.session, 'Configurações', content, pageScript));
});

app.post('/api/settings/profile-picture', isAuthenticated, async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ message: 'URL é obrigatória.' });

    await prisma.user.update({
        where: { id: req.session.user.id },
        data: { profilePictureUrl: url }
    });

    res.json({ message: 'Foto de perfil atualizada.' });
});

app.post('/api/settings/username', isAuthenticated, async (req, res) => {
    const { username } = req.body;
    if (!username || username.length < 3) {
        return res.status(400).json({ message: 'O nome de usuário deve ter pelo menos 3 caracteres.' });
    }

    const existingUser = await prisma.user.findUnique({ where: { username } });
    if (existingUser && existingUser.id !== req.session.user.id) {
        return res.status(409).json({ message: 'Este nome de usuário já está em uso.' });
    }

    await prisma.user.update({
        where: { id: req.session.user.id },
        data: { username }
    });

    req.session.user.username = username; // Atualiza o nome na sessão
    req.session.save();

    res.json({ message: 'Nome de usuário atualizado.' });
});

app.post('/api/settings/password', isAuthenticated, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.session.user.id } });
    const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);

    if (!isMatch) {
        return res.status(401).json({ message: 'A senha atual está incorreta.' });
    }

    const salt = await bcrypt.genSalt(10);
    const newPasswordHash = await bcrypt.hash(newPassword, salt);

    await prisma.user.update({
        where: { id: req.session.user.id },
        data: { passwordHash: newPasswordHash }
    });

    res.json({ message: 'Senha alterada com sucesso.' });
});

// --- Página do Chat Global (Protegida) ---
app.get('/chat', isAuthenticated, (req, res) => {
    const content = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Chat Global - uberzer</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body { margin: 0; padding-bottom: 3rem; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #1e1e1e; color: #f0f0f0; }
            #form { background: rgba(0, 0, 0, 0.15); padding: 0.25rem; position: fixed; bottom: 0; left: 0; right: 0; display: flex; height: 3rem; box-sizing: border-box; backdrop-filter: blur(10px); }
            #input { border: none; padding: 0 1rem; flex-grow: 1; border-radius: 2rem; margin: 0.25rem; background: #333; color: #fff; }
            #input:focus { outline: none; }
            #form > button { background: #bb86fc; border: none; padding: 0 1rem; margin: 0.25rem; border-radius: 3px; outline: none; color: #fff; cursor: pointer; }
            #messages { list-style-type: none; margin: 0; padding: 0; }
            #messages > li { padding: 0.5rem 1rem; }
            #messages > li:nth-child(odd) { background: #252526; }
            .system-message { color: #888; font-style: italic; }
            .username { font-weight: bold; color: #bb86fc; }
            #leave-chat {
                position: fixed;
                top: 10px;
                right: 10px;
                background: #e74c3c;
                color: white;
                padding: 8px 15px;
                border-radius: 5px;
                text-decoration: none;
                font-size: 0.9em;
                z-index: 10;
            }
        </style>
    </head>
    <body>
        <ul id="messages"></ul>
        <form id="form" action="">
            <input id="input" autocomplete="off" placeholder="Digite sua mensagem..." /><button>Enviar</button>
        </form>
        <a href="/dashboard" id="leave-chat">Sair do Chat</a>
        <script src="/socket.io/socket.io.js"></script>
        <script>
            const socket = io();
            const form = document.getElementById('form');
            const input = document.getElementById('input');
            const messages = document.getElementById('messages');
            const currentUser = "${req.session.user.username}";

            form.addEventListener('submit', function(e) {
                e.preventDefault();
                if (input.value) {
                    socket.emit('chat message', input.value);
                    input.value = '';
                }
            });

            socket.on('chat message', function(data) {
                const item = document.createElement('li');
                if (data.username === 'Sistema') {
                    item.classList.add('system-message');
                    item.textContent = data.msg;
                } else {
                    const userSpan = document.createElement('span');
                    userSpan.classList.add('username');
                    userSpan.textContent = data.username + ': ';
                    item.appendChild(userSpan);
                    item.appendChild(document.createTextNode(data.msg));
                }
                messages.appendChild(item);
                window.scrollTo(0, document.body.scrollHeight);
            });

        </script>
    </body></html>`;
    // Chat é uma página completa, então não usa o layout padrão do dashboard
    res.send(content.replace('</body>', `${banHandlerScript}</body>`));
});

// --- Lógica de Batalha e Dados ---
const opponents = [
    { name: 'Goblin Sorrateiro', power: 80, health: 60 },
    { name: 'Orc Brutamontes', power: 120, health: 150 },
    { name: 'Feiticeira do Pântano', power: 150, health: 90 },
    { name: 'Cavaleiro Caído', power: 200, health: 200 },
    { name: 'Lich Ancestral', power: 280, health: 180 },
    { name: 'Dragão Vermelho Jovem', power: 350, health: 400 },
];

function getBattleScriptContent() {
    return `
    function addLog(message, color) {
        const logList = document.getElementById('log-list');
        if (!logList) return;
        const li = document.createElement('li');
        li.textContent = message;
        logList.insertBefore(li, logList.firstChild);
    }

    function showDamage(fighterElement, amount) {
        if (!fighterElement || !amount || amount <= 0) return;
        const damageEl = document.createElement('div');
        damageEl.className = 'damage-popup';
        damageEl.textContent = amount;
        fighterElement.appendChild(damageEl);
        fighterElement.classList.add('shake-anim');
        setTimeout(() => damageEl.remove(), 1000);
        setTimeout(() => fighterElement.classList.remove('shake-anim'), 300);
    }

    function playJacketAwakening() {
        const awakeningOverlay = document.getElementById('awakening-overlay');
        awakeningOverlay.classList.add('awakening-active');
        awakeningOverlay.style.display = 'flex';
        awakeningOverlay.innerHTML = '<div id="jacket-line" class="awakening-line"></div><audio id="awakening-audio" autoplay loop><source src="/audio/jacket-theme.mp3" type="audio/mpeg"></audio>';
        const lineEl = document.getElementById('jacket-line');
        const messages = ["Wrong number...", "Do you like hurting other people?", "It's time..."];
        let msgIndex = 0;
        const audio = document.getElementById('awakening-audio');
        if (audio) audio.volume = 0.5;
        const interval = setInterval(() => {
            if (!lineEl) { clearInterval(interval); return; }
            lineEl.textContent = messages[msgIndex];
            msgIndex++;
            if (msgIndex > messages.length) {
                clearInterval(interval);
                awakeningOverlay.style.display = 'none';
            }
        }, 1500);
    }

    function playOverlordAwakening() {
        const awakeningOverlay = document.getElementById('awakening-overlay');
        awakeningOverlay.classList.add('overlord-awakening-active');
        awakeningOverlay.style.display = 'flex';
        awakeningOverlay.innerHTML = '<div class="overlord-aura"></div><audio id="awakening-audio" autoplay loop><source src="/audio/overlord-theme.mp3" type="audio/mpeg"></audio>';
        const aura = awakeningOverlay.querySelector('.overlord-aura');
        const audio = document.getElementById('awakening-audio');
        if (audio) audio.volume = 0.5;
        let strikeCount = 0;
        const interval = setInterval(() => {
            if (strikeCount >= 20) {
                clearInterval(interval);
                awakeningOverlay.classList.remove('overlord-awakening-active');
                awakeningOverlay.style.display = 'none';
                return;
            }
            const lightning = document.createElement('div');
            lightning.className = 'lightning';
            lightning.style.left = Math.random() * 100 + '%';
            lightning.style.top = Math.random() * 100 + '%';
            lightning.style.transform = 'rotate(' + (Math.random() * 360) + 'deg)';
            if (aura) aura.appendChild(lightning);
            setTimeout(() => lightning.remove(), 200);
            strikeCount++;
        }, 100);
    }

    function playRatoMarombaAwakening() {
        const awakeningOverlay = document.getElementById('awakening-overlay');
        awakeningOverlay.classList.add('rat-awakening-active'); // Use the new custom class
        awakeningOverlay.style.display = 'flex';
        awakeningOverlay.innerHTML = '<div id="rat-line" class="awakening-line" style="font-family: \\'Impact\\', sans-serif; text-shadow: 2px 2px #000;"></div><audio id="awakening-audio" autoplay loop><source src="/audio/rato-maromba-theme.mp3" type="audio/mpeg"></audio>';
        const lineEl = document.getElementById('rat-line');
        const messages = ["DOR É O FRANGO SAINDO...", "110% FOCADO!", "É HORA DO SHOW!", "BIIIRL!"];
        let msgIndex = 0;
        const audio = document.getElementById('awakening-audio');
        if (audio) audio.volume = 0.5;

        const interval = setInterval(() => {
            if (!lineEl) { clearInterval(interval); return; }
            
            // Add special effect for the last message
            if (msgIndex === messages.length - 1) {
                lineEl.style.fontSize = '10vw';
                lineEl.style.color = 'var(--danger-accent)';
                document.body.classList.add('shake-anim'); // Shake the screen
            }

            lineEl.textContent = messages[msgIndex];
            msgIndex++;
            if (msgIndex >= messages.length) {
                clearInterval(interval);
                setTimeout(() => { 
                    awakeningOverlay.classList.remove('rat-awakening-active');
                    awakeningOverlay.style.display = 'none'; 
                    document.body.classList.remove('shake-anim');
                }, 2000);
            }
        }, 1500);
    }

    function playOpponentAwakening(data) {
        const overlay = document.getElementById('awakening-overlay');
        const character = data.character;
        const messages = data.messages;
        const theme = data.theme;
        const awakeningClass = character === 'The Overlord' ? 'overlord-awakening-active' : 'awakening-active';
        overlay.classList.add(awakeningClass);
        overlay.style.display = 'flex';
        overlay.innerHTML = \`<div class="awakening-line"></div><audio id="opponent-awakening-audio" autoplay loop><source src="\${theme}" type="audio/mpeg"></audio>\`;
        const lineEl = overlay.querySelector('.awakening-line');
        let msgIndex = 0;
        const interval = setInterval(() => {
            if (msgIndex >= messages.length) {
                clearInterval(interval);
                overlay.classList.remove(awakeningClass);
                overlay.style.display = 'none';
            } else {
                if (lineEl) lineEl.textContent = messages[msgIndex++];
            }
        }, 2000);
    }

    socket.on('play awakening', (data) => {
        if (data.character === 'Jacket') playJacketAwakening();
        if (data.character === 'The Overlord') playOverlordAwakening();
        if (data.character === 'RATO MAROMBA') playRatoMarombaAwakening();
    });

    socket.on('awakening end', () => {
        const awakeningOverlay = document.getElementById('awakening-overlay');
        awakeningOverlay.classList.remove('awakening-active', 'overlord-awakening-active', 'rat-awakening-active');
        document.body.classList.remove('awakening-active', 'overlord-awakening-active', 'rat-awakening-active');
        const opponentAudio = document.getElementById('opponent-awakening-audio');
        if (opponentAudio) opponentAudio.pause();
        const audio = document.getElementById('awakening-audio');
        if (audio) {
            audio.pause();
            audio.currentTime = 0;
        }
    });

    socket.on('play opponent awakening', (data) => {
        playOpponentAwakening(data);
    });

    function playJacketAbility(targetElement) {
        if (!targetElement) return;
        let hitCount = 0;
        const interval = setInterval(() => {
            if (hitCount >= 50) {
                clearInterval(interval);
                return;
            }
            const damageEl = document.createElement('div');
            damageEl.className = 'damage-popup';
            damageEl.textContent = Math.floor(Math.random() * 10) + 1;
            damageEl.style.left = (Math.random() * 80 + 10) + '%';
            damageEl.style.top = (Math.random() * 60 + 20) + '%';
            damageEl.style.color = ['#ff00ff', '#00ffff', '#ffffff'][hitCount % 3];
            targetElement.appendChild(damageEl);
            targetElement.classList.add('shake-anim');
            setTimeout(() => damageEl.remove(), 500);
            setTimeout(() => targetElement.classList.remove('shake-anim'), 300);
            const bloodEl = document.createElement('div');
            bloodEl.className = 'blood-particle';
            bloodEl.style.left = (Math.random() * 90 + 5) + '%';
            bloodEl.style.top = (Math.random() * 80 + 10) + '%';
            targetElement.appendChild(bloodEl);
            setTimeout(() => bloodEl.remove(), 600);
            hitCount++;
        }, 30);
    }

    function playOverlordAbility(targetElement) {
        if (!targetElement) return;
        targetElement.style.transition = 'opacity 1s ease-out, filter 1s ease-out';
        targetElement.style.opacity = '0';
        targetElement.style.filter = 'blur(10px) grayscale(100%)';
        addLog('O oponente se desintegra perante o poder absoluto...', 'var(--admin-accent)');
    }

    socket.on('battle update', (data) => {
        const opponentNameEl = document.getElementById('opponent-name');
        const abilityBtn = document.querySelector('#ability-btn');
        const oldAwakenedBtn = document.getElementById('awakened-ability-btn');
        if (oldAwakenedBtn) oldAwakenedBtn.remove();
        
        addLog(data.log);
        
        if (opponentNameEl) opponentNameEl.textContent = data.opponent.name;
        
        document.getElementById('player-health-bar').style.width = (data.player.health / data.player.maxHealth * 100) + '%';
        document.getElementById('player-health-text').textContent = \`\${data.player.health} / \${data.player.maxHealth}\`;
        document.getElementById('opponent-health-bar').style.width = (data.opponent.health / data.opponent.maxHealth * 100) + '%';
        document.getElementById('opponent-health-text').textContent = \`\${data.opponent.health} / \${data.opponent.maxHealth}\`;
        
        showDamage(document.getElementById('player-fighter'), data.damageToPlayer);
        showDamage(document.getElementById('opponent-fighter'), data.damageToOpponent);
        
        if (data.abilityUsed === 'Jacket') playJacketAbility(document.getElementById('opponent-fighter'));
        if (data.abilityUsed === 'The Overlord') playOverlordAbility(document.getElementById('opponent-fighter'));
        // No special effect for Rato Maromba's hit, just the big damage number.
        
        const currentBattleActionsEl = document.getElementById('battle-actions');
        if (currentBattleActionsEl) currentBattleActionsEl.style.display = 'none';
        
        if (data.isPlayerTurn) {
            if (currentBattleActionsEl) currentBattleActionsEl.style.display = 'block';
            if (data.canUseAbility && abilityBtn) abilityBtn.style.display = 'inline-block';
            
            if (data.player.awakenedState.active) {
                let awakeningClass = 'awakening-active'; // Default RGB
                if (data.player.awakenedState.character === 'The Overlord') {
                    awakeningClass = 'overlord-awakening-active'; // B&W Pulse
                } else if (data.player.awakenedState.character === 'RATO MAROMBA') {
                    awakeningClass = 'rat-awakening-active'; // Gym Spotlight
                }
                document.body.classList.add(awakeningClass);
                
                document.querySelector("[onclick*='fast_attack']").style.display = 'none';
                document.querySelector("[onclick*='strong_attack']").style.display = 'none';
                document.querySelector("[onclick*='defend']").style.display = 'none';
                if (document.querySelector("[onclick*='use_ability']")) document.querySelector("[onclick*='use_ability']").style.display = 'none';
                if (abilityBtn) abilityBtn.style.display = 'none';
                
                const awakenedBtn = document.createElement('button');
                awakenedBtn.id = 'awakened-ability-btn';
                awakenedBtn.className = \`btn btn-special \${awakeningClass}\`;
                awakenedBtn.textContent = data.player.awakenedState.abilityName;
                awakenedBtn.onclick = () => sendAction('awakened_ability');
                if (currentBattleActionsEl) currentBattleActionsEl.appendChild(awakenedBtn);
            } else {
                document.body.classList.remove('awakening-active', 'overlord-awakening-active', 'rat-awakening-active');
                const fastAttackBtn = document.querySelector("[onclick*='fast_attack']");
                if (fastAttackBtn) fastAttackBtn.style.display = 'inline-block';
                const strongAttackBtn = document.querySelector("[onclick*='strong_attack']");
                if (strongAttackBtn) strongAttackBtn.style.display = 'inline-block';
                const defendBtn = document.querySelector("[onclick*='defend']");
                if (defendBtn) defendBtn.style.display = 'inline-block';
                if (data.canUseAbility && abilityBtn) abilityBtn.style.display = 'inline-block';
            }
        }
    });

    socket.on('battle end', (data) => {
        const currentBattleActionsEl = document.getElementById('battle-actions');
        if (currentBattleActionsEl) currentBattleActionsEl.style.display = 'none';
        addLog(data.message);
        setTimeout(() => {
            showNotification(data.message + (data.win ? ' Você ganhou 50 moedas!' : ' Você perdeu 25 moedas.'), data.win ? 'success' : 'error');
            window.location.reload();
        }, 2000);
    });
`;
}

function getFullBattleScript(actionEventName) {
    return `
        window.sendAction = function(action) { socket.emit('${actionEventName}', action); const battleActionsEl = document.getElementById('battle-actions'); if(battleActionsEl) battleActionsEl.style.display = 'none'; };
        ${getBattleScriptContent()}
    `;
}

app.get('/fight', isAuthenticated, async (req, res) => {
    const user = await prisma.user.findUnique({
        where: { id: req.session.user.id },
        include: { characters: true, swords: true }
    });
    if (!user) return res.redirect('/login');
    
    const { buffs, totalPower, totalHealth } = calculatePlayerBuffs(user, user.characters || [], user.swords || []);

    const content = `
        <h1>Arena de Batalha</h1>
        <div id="pre-battle-screen">
             <div class="card">
                 <p>Seus personagens te concedem os seguintes bônus: <br><strong>${buffs.summary}</strong></p>
                 <p>Seu Poder de Combate é: <strong>${totalPower}</strong> | Sua Vida Máxima é: <strong>${totalHealth}</strong></p>
             </div>
             <button id="find-fight-btn" class="btn">Procurar Luta</button>
        </div>

        <div id="battle-screen" style="display: none;">
            <div class="battle-arena">
                <div class="fighter" id="player-fighter">
                    <div class="fighter-sprite" style="background-color: var(--info-accent);"></div>
                    <h2 class="fighter-name">${req.session.user.username}</h2>
                    <div class="health-bar-container">
                        <div id="player-health-bar" class="health-bar"></div>
                    </div>
                    <div id="player-health-text" class="health-text">${totalHealth} / ${totalHealth}</div>
                </div>
                <div class="fighter" id="opponent-fighter">
                    <div class="fighter-sprite" style="background-color: var(--danger-accent);"></div>
                    <h2 id="opponent-name" class="fighter-name">???</h2>
                    <div class="health-bar-container">
                        <div id="opponent-health-bar" class="health-bar"></div>
                    </div>
                    <div id="opponent-health-text" class="health-text">??? / ???</div>
                </div>
            </div>
            <div id="battle-actions" class="card" style="text-align: center;">
                 <h3>Seu Turno!</h3>
                 <button class="btn" onclick="sendAction('fast_attack')">Ataque Rápido</button>
                 <button class="btn" onclick="sendAction('strong_attack')">Ataque Forte</button>
                 <button class="btn" onclick="sendAction('defend')">Defender</button>
                 <button id="ability-btn" class="btn btn-special" onclick="sendAction('use_ability')">Despertar</button>
            </div>
             <div id="battle-log" class="card" style="margin-top: 20px; max-height: 200px; overflow-y: auto;">
                 <h4>Log de Combate</h4>
                 <ul id="log-list" style="list-style: none; padding: 0; font-size: 0.9em;"></ul>
             </div>
        </div>
        <div id="awakening-overlay"></div>
        `;

    const pageScript = `
        document.getElementById('find-fight-btn').addEventListener('click', async () => {
            document.getElementById('pre-battle-screen').style.display = 'none';
            document.getElementById('battle-screen').style.display = 'block';
            socket.emit('start battle');
        });
        ${getFullBattleScript('battle action')}
    `;
    res.send(renderDashboardPage(req.session, 'Lutar', content, pageScript));
});

// --- PÁGINA DE STATUS E NÍVEL ---
app.get('/status', isAuthenticated, async (req, res) => {
    const user = await prisma.user.findUnique({
        where: { id: req.session.user.id },
        select: { level: true, xp: true, xpToNextLevel: true, statPoints: true, strength: true, vitality: true }
    });

    const xpPercentage = (user.xp / user.xpToNextLevel) * 100;

    const content = `
        <style>
            .xp-bar-container { background: var(--bg-dark-tertiary); border-radius: 10px; padding: 4px; margin: 10px 0 20px 0; }
            .xp-bar { height: 25px; background: linear-gradient(to right, var(--info-accent), #8e44ad); border-radius: 6px; width: ${xpPercentage}%; transition: width 0.5s ease; }
            .stat-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #333; }
            .stat-name { font-weight: 600; font-size: 1.1em; }
            .stat-value { font-size: 1.1em; }
            .stat-allocator button { background: var(--success-accent); border: none; color: white; width: 30px; height: 30px; border-radius: 50%; font-size: 1.2em; cursor: pointer; margin-left: 15px; }
            .stat-allocator button:disabled { background: #555; cursor: not-allowed; }
        </style>
        <h1>Status & Nível</h1>
        <div class="card">
            <h2>Nível ${user.level}</h2>
            <p>Experiência: ${user.xp} / ${user.xpToNextLevel}</p>
            <div class="xp-bar-container"><div class="xp-bar"></div></div>
            <p>Você tem <strong style="color: var(--admin-accent);">${user.statPoints}</strong> pontos para distribuir.</p>
        </div>

        <div class="card">
            <h2>Atributos</h2>
            <form id="stats-form">
                <div class="stat-row">
                    <div>
                        <span class="stat-name">Força</span>
                        <p style="font-size: 0.8em; color: var(--text-light-secondary); margin: 0;">Aumenta o dano dos seus ataques.</p>
                    </div>
                    <div class="stat-allocator">
                        <span class="stat-value">${user.strength}</span>
                        <button type="button" data-stat="strength" ${user.statPoints <= 0 ? 'disabled' : ''}>+</button>
                    </div>
                </div>
                <div class="stat-row">
                    <div>
                        <span class="stat-name">Vitalidade</span>
                        <p style="font-size: 0.8em; color: var(--text-light-secondary); margin: 0;">Aumenta sua vida máxima.</p>
                    </div>
                    <div class="stat-allocator">
                        <span class="stat-value">${user.vitality}</span>
                        <button type="button" data-stat="vitality" ${user.statPoints <= 0 ? 'disabled' : ''}>+</button>
                    </div>
                </div>
                <button type="submit" class="btn" style="margin-top: 20px;" disabled>Salvar Alterações</button>
            </form>
        </div>
    `;

    const pageScript = `
        const form = document.getElementById('stats-form');
        const saveBtn = form.querySelector('button[type="submit"]');
        let pointsToAllocate = {};
        let availablePoints = ${user.statPoints};

        form.addEventListener('click', (e) => {
            if (e.target.tagName === 'BUTTON' && e.target.dataset.stat) {
                const stat = e.target.dataset.stat;
                if (availablePoints > 0) {
                    pointsToAllocate[stat] = (pointsToAllocate[stat] || 0) + 1;
                    availablePoints--;

                    const valueEl = e.target.previousElementSibling;
                    valueEl.textContent = parseInt(valueEl.textContent) + 1;
                    
                    document.querySelector('p > strong').textContent = availablePoints;
                    saveBtn.disabled = false;

                    if (availablePoints === 0) {
                        form.querySelectorAll('.stat-allocator button').forEach(btn => btn.disabled = true);
                    }
                }
            }
        });

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const response = await fetch('/api/status/allocate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(pointsToAllocate)
            });
            if (response.ok) {
                showNotification('Status atualizados com sucesso!', 'success');
                setTimeout(() => window.location.reload(), 1500);
            } else {
                const data = await response.json();
                showNotification(data.message, 'error');
            }
        });
    `;

    res.send(renderDashboardPage(req.session, 'Status', content, pageScript));
});

app.post('/api/status/allocate', isAuthenticated, async (req, res) => {
    const pointsToAllocate = req.body; // { strength: 2, vitality: 3 }
    const userId = req.session.user.id;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    const totalPointsToSpend = Object.values(pointsToAllocate).reduce((sum, val) => sum + val, 0);

    if (totalPointsToSpend <= 0 || user.statPoints < totalPointsToSpend) {
        return res.status(400).json({ message: 'Pontos de status insuficientes.' });
    }

    await prisma.user.update({
        where: { id: userId },
        data: {
            strength: { increment: pointsToAllocate.strength || 0 },
            vitality: { increment: pointsToAllocate.vitality || 0 },
            statPoints: { decrement: totalPointsToSpend }
        }
    });

    res.json({ message: 'Status atualizados.' });
});

// --- Página e API de Tickets de Suporte ---

app.get('/tickets', isAuthenticated, async (req, res) => {
    const userEmail = req.session.user.email;
    const userTickets = await prisma.ticket.findMany({
        where: { author: { email: userEmail } },
        orderBy: { createdAt: 'desc' }
    });

    const ticketsHtml = userTickets.map(ticket => `
        <a href="/ticket/${ticket.id}" class="ticket-link">
            <div class="card">
                <h3>${ticket.subject} <span style="font-size: 0.8em; color: ${ticket.status === 'open' ? 'var(--danger-accent)' : 'var(--success-accent)'};">(${ticket.status})</span></h3>
                <small style="color: var(--text-light-secondary);">${new Date(ticket.createdAt).toLocaleString('pt-BR')}</small>
            </div>
        </a>
    `).join('');

    const content = `
        <h1>Suporte</h1>
        <div class="card">
            <h2>Abrir Novo Ticket</h2>
            <form id="ticket-form">
                <div class="form-group">
                    <label for="subject">Assunto</label>
                    <input type="text" id="subject" name="subject" required>
                </div>
                <div class="form-group">
                    <label for="message">Mensagem</label>
                    <textarea id="message" name="message" rows="5" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #444; background-color: var(--bg-dark-tertiary); color: var(--text-light-primary); font-family: 'Poppins', sans-serif;"></textarea>
                </div>
                <button type="submit" class="btn">Enviar Ticket</button>
            </form>
        </div>
        <h2>Meus Tickets</h2>
        ${ticketsHtml || '<p>Você não abriu nenhum ticket ainda.</p>'}
        <script>
            document.getElementById('ticket-form').addEventListener('submit', async (e) => {
                e.preventDefault();
                const subject = e.target.subject.value;
                const message = e.target.message.value;
                const response = await fetch('/api/tickets/create', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ subject, message })
                });
                if (response.ok) {
                    showNotification('Ticket enviado com sucesso!', 'success');
                    window.location.reload();
                } else {
                    showNotification('Erro ao enviar ticket.', 'error');
                }
            });
        </script>
    `;
    res.send(renderDashboardPage(req.session, 'Suporte', content));
});

app.post('/api/tickets/create', isAuthenticated, async (req, res) => {
    const { subject, message } = req.body;
    const newTicket = await prisma.ticket.create({
        data: {
            subject,
            message,
            author: {
                connect: { id: req.session.user.id }
            },
            messages: {
                create: { content: message, authorName: req.session.user.username, isAdmin: req.session.user.isAdmin }
            }
        }
    });

    // Envia e-mail de confirmação para o usuário
    const emailHtml = createStyledEmail({
        title: 'Ticket de Suporte Recebido',
        bodyContent: `
            <p style="color: #b3b3b3; font-size: 16px; line-height: 24px;">Olá, ${req.session.user.username}.</p>
            <p style="color: #b3b3b3; font-size: 16px; line-height: 24px;">Recebemos seu ticket de suporte (ID: ${newTicket.id}) e nossa equipe irá analisá-lo em breve. Abaixo estão os detalhes:</p>
            <div style="background-color: #2a2a2a; padding: 15px; border-radius: 8px; margin: 20px 0; color: #e0e0e0;"><strong>Assunto:</strong> ${newTicket.subject}<br><strong>Mensagem:</strong> ${newTicket.message}</div>
        `
    });
    sgMail.send({
        to: req.session.user.email,
        from: { name: 'Suporte uberzer', email: process.env.EMAIL_USER },
        subject: `Confirmação do Ticket #${newTicket.id}: ${newTicket.subject}`,
        html: emailHtml
    }).catch(err => console.error("Erro ao enviar e-mail de confirmação de ticket:", err));

    // Notifica os admins em tempo real sobre o novo ticket
    io.to('admin-room').emit('new ticket', { ...newTicket, author: { username: req.session.user.username, email: req.session.user.email } });

    res.status(201).json({ message: 'Ticket criado com sucesso!', ticket: newTicket });
});

// --- Página de Visualização de um Ticket (Chat) ---
app.get('/ticket/:id', isAuthenticated, async (req, res) => {
    const ticketId = parseInt(req.params.id, 10);
    const userId = req.session.user.id;
    const isAdmin = req.session.user.isAdmin;

    const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        include: { 
            author: true,
            messages: {
                orderBy: { createdAt: 'asc' }
            }
        }
    });

    // Validação: o usuário deve ser o autor do ticket ou um admin
    if (!ticket || (!isAdmin && ticket.authorId !== userId)) {
        return res.status(403).send('Acesso negado.');
    } 

    const messagesHtml = ticket.messages.map(msg => `
        <div class="message-bubble ${msg.isAdmin ? 'admin-message' : 'user-message'}">
            <strong>${msg.authorName}:</strong><br>
            ${msg.content}
            <div style="font-size: 0.7em; text-align: right; opacity: 0.7;">${new Date(msg.createdAt).toLocaleTimeString('pt-BR')}</div>
        </div>
    `).join('');

    const pageContent = `
        <h1>Ticket #${ticket.id}: ${ticket.subject} (${ticket.status})</h1>
        <div class="card">
            <div id="message-container" style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px; max-height: 50vh; overflow-y: auto; padding-right: 10px;">
                ${messagesHtml || '<p>Nenhuma mensagem ainda.</p>'}
            </div>
            <form id="reply-form">
                <div class="form-group">
                    <textarea id="reply-content" name="content" rows="3" required placeholder="Digite sua resposta..." style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #444; background-color: var(--bg-dark-tertiary); color: var(--text-light-primary); font-family: 'Poppins', sans-serif;"></textarea>
                </div>
                <button type="submit" class="btn">Enviar Resposta</button>
            </form>
        </div>
    `;

    const pageScript = `
        const ticketId = ${ticket.id};
        const form = document.getElementById('reply-form');
        const contentInput = document.getElementById('reply-content');
        const messageContainer = document.getElementById('message-container');

        // Entra na sala do ticket ao carregar a página
        socket.emit('join ticket room', ticketId);

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const content = contentInput.value.trim();
            if (content) {
                socket.emit('ticket message', { ticketId, content });
                contentInput.value = '';
            }
        });

        socket.on('new ticket message', (msg) => {
            const messageEl = document.createElement('div');
            messageEl.classList.add('message-bubble', msg.isAdmin ? 'admin-message' : 'user-message');
            messageEl.innerHTML = \`<strong>\${msg.authorName}:</strong><br>\${msg.content}<div style="font-size: 0.7em; text-align: right; opacity: 0.7;">\${new Date(msg.createdAt).toLocaleTimeString('pt-BR')}</div>\`;
            messageContainer.appendChild(messageEl);
            messageContainer.scrollTop = messageContainer.scrollHeight; // Rola para a última mensagem
        });
    `;

    res.send(renderDashboardPage(req.session, `Ticket #${ticket.id}`, pageContent, pageScript));
});

// --- Lógica e Dados do Sistema de Sorteio de Personagens ---
const rarities = {
    COMUM: { name: 'Comum', color: '#9e9e9e', chance: 0.60 },
    RARO: { name: 'Raro', color: '#42a5f5', chance: 0.25 },
    LENDARIO: { name: 'Lendário', color: '#ab47bc', chance: 0.10 },
    MITICO: { name: 'Mítico', color: '#ff7043', chance: 0.045 },
    CHATYNIRARES: { name: 'Chatynirares', color: '#ffee58', chance: 0.005 },
    SUPREME: { name: 'Supreme', color: '#f1c40f', chance: 0 } // Raridade exclusiva, não pode ser sorteada
};

const ROLL_COST = 150;

const charactersByRarity = {
    COMUM: [
        { name: 'Guerreiro de Taverna', ability: 'Golpe Básico', buff: { description: '+5 de Vida', type: 'health_flat', value: 5 } },
        { name: 'Mago Aprendiz', ability: 'Faísca Mágica', buff: { description: '+1% de Ataque', type: 'attack_percent', value: 0.01 } },
        { name: 'Ladino de Beco', ability: 'Ataque Furtivo Simples', buff: { description: '+1% de Defesa', type: 'defense_percent', value: 0.01 } }
    ],
    RARO: [
        { name: 'Cavaleiro de Aço', ability: 'Investida Poderosa', buff: { description: '+3% de Defesa', type: 'defense_percent', value: 0.03 } },
        { name: 'Feiticeiro Elemental', ability: 'Bola de Fogo', buff: { description: '+3% de Ataque', type: 'attack_percent', value: 0.03 } },
        { name: 'Arqueiro Élfico', ability: 'Flecha Precisa', buff: { description: '+20 de Vida', type: 'health_flat', value: 20 } }
    ],
    LENDARIO: [
        { name: 'Paladino da Luz Solar', ability: 'Cura Divina', buff: { description: '+10% de Defesa', type: 'defense_percent', value: 0.10 } },
        { name: 'Arquimago do Tempo', ability: 'Parar o Tempo (1s)', buff: { description: '+100 de Vida', type: 'health_flat', value: 100 } },
        { name: 'Mestre das Sombras', ability: 'Invisibilidade', buff: { description: '+8% de Ataque', type: 'attack_percent', value: 0.08 } }
    ],
    MITICO: [
        { name: 'Avatar do Dragão', ability: 'Sopro de Fogo em Cone', buff: { description: '+15% de Ataque', type: 'attack_percent', value: 0.15 } },
        { name: 'Portador da Lâmina Cósmica', ability: 'Golpe Meteoro', buff: { description: '+500 de Vida', type: 'health_flat', value: 500 } }
    ],
    CHATYNIRARES: [
        { name: 'Deus da Forja Estelar', ability: 'Criar Realidade', buff: { description: '+25% de Ataque e Defesa', type: 'all_percent', value: 0.25 } }
    ],
    SUPREME: [
        { name: 'The Overlord', ability: 'Absolute Power', attack: 999999, health: 9999999, buff: { description: 'Imune a todos os efeitos negativos. Causa dano letal.', type: 'attack_flat', value: 999999 } }
    ]
};

const SWORD_ROLL_COST = 250;

const swordsByRarity = {
    COMUM: [
        { name: 'Adaga Enferrujada', description: 'Melhor que nada.', attackBonus: 5, rarity: Rarity.COMUM },
        { name: 'Espada Curta', description: 'Uma espada curta e confiável.', attackBonus: 8, rarity: Rarity.COMUM }
    ],
    RARO: [
        { name: 'Cimitarra de Aço', description: 'Uma lâmina curva e afiada.', attackBonus: 15, rarity: Rarity.RARO },
        { name: 'Machado de Batalha', description: 'Pesado e intimidador.', attackBonus: 20, rarity: Rarity.RARO }
    ],
    LENDARIO: [
        { name: 'Lâmina Vorpal', description: 'Corta com precisão mortal.', attackBonus: 40, rarity: Rarity.LENDARIO }
    ]
};

const exclusiveCharacters = {
    'RATO MAROMBA': { name: 'RATO MAROMBA', ability: 'Pump de Biceps', rarity: Rarity.SUPREME, rarityColor: rarities.SUPREME.color, buffDescription: 'EMANUEL_RATAO', attack: 500, health: 10000, buff: { description: '+20% de Ataque e +200 de Vida', type: 'mixed', value: { attack_percent: 0.20, health_flat: 200 } } },
    'Jacket': { name: 'Jacket', ability: 'Combo Violento', rarity: Rarity.SUPREME, rarityColor: rarities.SUPREME.color, attack: 300, health: 3500, buff: { description: 'Desfere um combo devastador de 300 golpes.', type: 'attack_flat', value: 300 } }
};

function rollCharacter() {
    const roll = Math.random();
    let cumulativeChance = 0;

    for (const rarityKey in rarities) {
        cumulativeChance += rarities[rarityKey].chance;
        if (roll < cumulativeChance) {
            const characterPool = charactersByRarity[rarityKey];
            const chosenCharacter = characterPool[Math.floor(Math.random() * characterPool.length)];
            return { ...chosenCharacter, rarity: rarities[rarityKey], rarityEnum: Rarity[rarityKey] };
        }
    }
}

function rollSword() {
    const roll = Math.random();
    let cumulativeChance = 0;

    // Usamos as mesmas chances de raridade dos personagens
    for (const rarityKey in rarities) {
        if (!swordsByRarity[rarityKey]) continue; // Pula raridades sem espadas definidas

        cumulativeChance += rarities[rarityKey].chance;
        if (roll < cumulativeChance) {
            const swordPool = swordsByRarity[rarityKey];
            const chosenSword = swordPool[Math.floor(Math.random() * swordPool.length)];
            // ✅ CORREÇÃO: Remove a propriedade 'rarity' antiga antes de adicionar a nova.
            // Isso evita que o Prisma Client receba um objeto malformado.
            const { rarity, ...restOfSword } = chosenSword;
            
            return { ...restOfSword, rarity: Rarity[rarityKey] };
        }
    }
}

/**
 * Calcula os buffs totais de uma lista de personagens.
 * @param {Array} characters - A lista de personagens do jogador.
 * @param {Array} swords - A lista de espadas do jogador.
 * @returns {{summary: string}} - Um objeto com a descrição resumida dos buffs.
 */
function calculatePlayerBuffs(user, characters = [], swords = []) {
    const accumulatedBuffs = {
        attack_percent: 0,
        defense_percent: 0,
        health_flat: 0,
        attack_flat: 0,
    };
    if (characters.length > 0) {
        const allTemplates = { ...exclusiveCharacters, ...Object.values(charactersByRarity).flat().reduce((acc, val) => ({...acc, [val.name]: val }), {}) };

        // 1. Encontra o personagem com a maior vida base para ser o "principal"
        const mainChar = characters.reduce((strongest, current) => {
            const currentTemplate = allTemplates[current.name];
            const strongestTemplate = allTemplates[strongest.name];
            return (currentTemplate?.health || 0) > (strongestTemplate?.health || 0) ? current : strongest;
        });

        const mainCharTemplate = allTemplates[mainChar.name];
        accumulatedBuffs.attack_flat += mainCharTemplate?.attack || 0;
        accumulatedBuffs.health_flat += mainCharTemplate?.health || 0;

        // 2. Itera sobre TODOS os personagens para somar os buffs
        for (const dbChar of characters) {
            const template = allTemplates[dbChar.name];
            if (template?.buff) {
                const buff = template.buff;
                if (buff.type === 'all_percent') {
                    accumulatedBuffs.attack_percent += buff.value;
                    accumulatedBuffs.defense_percent += buff.value;
                } else if (buff.type === 'mixed') {
                    accumulatedBuffs.attack_percent += buff.value.attack_percent;
                    accumulatedBuffs.health_flat += buff.value.health_flat;
                } else if (accumulatedBuffs.hasOwnProperty(buff.type)) {
                    accumulatedBuffs[buff.type] += buff.value;
                }
            }
        }
    }

    const descriptions = [];
    if (accumulatedBuffs.attack_percent > 0) descriptions.push(`+${(accumulatedBuffs.attack_percent * 100).toFixed(0)}% de Ataque`);
    if (accumulatedBuffs.defense_percent > 0) descriptions.push(`+${(accumulatedBuffs.defense_percent * 100).toFixed(0)}% de Defesa`);
    if (accumulatedBuffs.health_flat > 0) descriptions.push(`+${accumulatedBuffs.health_flat} de Vida`);

    const bestSword = swords.reduce((best, current) => (current.attackBonus > best.attackBonus ? current : best), { attackBonus: 0 });
    if (bestSword.attackBonus > 0) {
        descriptions.push(`+${bestSword.attackBonus} de Ataque (Espada)`);
    }
    
    // A vida e poder base agora vêm dos atributos do usuário, não mais fixos em 100.
    const basePowerFromStats = 10 + (user.strength * 2);
    const baseHealthFromStats = 50 + (user.vitality * 10);

    const totalPower = Math.floor((basePowerFromStats + accumulatedBuffs.attack_flat) * (1 + accumulatedBuffs.attack_percent) + bestSword.attackBonus);
    const totalHealth = baseHealthFromStats + accumulatedBuffs.health_flat;

    const activeCharacterForAbility = characters.sort((a, b) => Object.keys(Rarity).indexOf(b.rarity) - Object.keys(Rarity).indexOf(a.rarity))[0];

    return { buffs: { summary: descriptions.join(', ') || 'Nenhum buff ativo' }, totalPower, totalHealth, defenseBonus: accumulatedBuffs.defense_percent, activeCharacter: activeCharacterForAbility };
}

// --- Página de Personagens (Sorteio e Visualização) ---
app.get('/characters', isAuthenticated, async (req, res) => {
    const user = await prisma.user.findUnique({
        where: { id: req.session.user.id },
        include: { characters: { orderBy: { rarity: 'desc' } } }
    });
    if (!user) return res.redirect('/login');

    const userCoins = user.coins || 0;
    const userCharacters = user.characters || [];
    
    let charactersHtml = userCharacters.map(char => `
        <div class="char-card" style="border-left-color: ${char.rarityColor};">
            <div class="char-rarity" style="color: ${char.rarityColor};">${char.rarity}</div>
            <div class="char-name">${char.name}</div>
            <div class="char-ability">Buff: ${char.buffDescription || 'Nenhum'}</div>
        </div>
    `).join('');


    const content = `
        <h1>Meus Personagens</h1>
        <div class="roll-section card">
            <p style="font-size: 1.2em; margin-bottom: 10px;">Seu Saldo: <span style="color: #ffee58;">${userCoins}</span> moedas</p>
            <button id="roll-btn" class="btn">Sortear Personagem (${ROLL_COST} moedas)</button>
        </div>
        <div class="characters-grid">${charactersHtml || '<p>Você ainda não tem personagens. Sorteie um!</p>'}</div>

        <!-- Overlay da Animação -->
        <div id="roll-animation-overlay">
            <div id="roll-card" class="char-card">
                <!-- Conteúdo será preenchido via JS -->
            </div>
        </div>

        <script>
            document.getElementById('roll-btn').addEventListener('click', async () => {
                const rollButton = document.getElementById('roll-btn');
                const overlay = document.getElementById('roll-animation-overlay');
                const rollCard = document.getElementById('roll-card');

                rollButton.disabled = true;
                rollButton.textContent = 'Sorteando...';
                overlay.classList.remove('is-chatynirares', 'reveal');
                overlay.classList.add('active');

                const response = await fetch('/api/character/roll', { method: 'POST' });
                
                if (response.ok) {
                    const result = await response.json();
                    // Preenche o card do resultado
                    rollCard.style.borderLeftColor = result.rarityColor;
                    rollCard.innerHTML = \`
                        <div class="char-rarity" style="color: \${result.rarityColor};">\${result.rarity}</div>
                        <div class="char-name">\${result.name}</div>
                        <div class="char-ability">Buff: \${result.buffDescription || 'Nenhum'}</div>\`;

                    // Se for Chatynirares, adiciona a classe especial
                    if (result.rarity === 'CHATYNIRARES') {
                        overlay.classList.add('is-chatynirares');
                    }

                    // Revela o card com animação
                    setTimeout(() => {
                        overlay.classList.add('reveal');
                    }, 500);

                    // Fecha a animação e recarrega a página
                    setTimeout(() => {
                        overlay.classList.remove('active', 'reveal', 'is-chatynirares');
                        window.location.reload();
                    }, 4000);

                } else {
                    const result = await response.json().catch(() => ({ message: 'Erro desconhecido.' }));
                    showNotification(result.message, 'error');
                    overlay.classList.remove('active'); // Fecha o overlay em caso de erro
                    rollButton.disabled = false;
                    rollButton.textContent = 'Sortear Personagem (' + ROLL_COST + ' moedas)';
                }
            });
        </script>
    `;
    res.send(renderDashboardPage(req.session, 'Meus Personagens', content));
});

// --- API para Sortear Personagem ---
app.post('/api/character/roll', isAuthenticated, async (req, res) => {
    const userId = req.session.user.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    // Verifica se o usuário tem moedas suficientes
    if (!user || user.coins < ROLL_COST) {
        return res.status(402).json({ message: 'Moedas insuficientes! Você precisa de ' + ROLL_COST + ' moedas para sortear.' }); // 402 Payment Required
    }
    
    const newCharacter = rollCharacter();
    
    // Atualiza o saldo e adiciona o novo personagem em uma transação
    const [, createdCharacter] = await prisma.$transaction([
        prisma.user.update({
            where: { id: userId },
            data: { coins: { decrement: ROLL_COST } },
        }),
        prisma.character.create({
            data: {
                name: newCharacter.name,
                ability: newCharacter.ability,
                rarity: newCharacter.rarityEnum,
                rarityColor: newCharacter.rarity.color,
                buffDescription: newCharacter.buff.description,
                ownerId: userId,
            }
        })
    ]);
    
    res.status(200).json(createdCharacter);
});

// --- Página de Estoque de Espadas ---
app.get('/swords', isAuthenticated, async (req, res) => {
    const user = await prisma.user.findUnique({
        where: { id: req.session.user.id },
        include: { swords: { orderBy: { attackBonus: 'desc' } } }
    });
    if (!user) return res.redirect('/login');

    const userCoins = user.coins || 0;
    const userSwords = user.swords || [];

    // A espada equipada é a primeira da lista, pois ordenamos por `attackBonus`
    const equippedSword = userSwords[0];

    let swordsHtml = userSwords.map((sword, index) => {
        const isEquipped = index === 0;
        const rarityInfo = Object.values(rarities).find(r => r.name.toUpperCase() === sword.rarity);
        const rarityColor = rarityInfo ? rarityInfo.color : '#9e9e9e';

        return `
        <div class="char-card" style="border-left-color: ${rarityColor}; ${isEquipped ? 'box-shadow: 0 0 15px ' + rarityColor + ';' : ''}">
            ${isEquipped ? '<div style="color: var(--success-accent); font-weight: bold; margin-bottom: 5px;">EQUIPADA</div>' : ''}
            <div class="char-rarity" style="color: ${rarityColor};">${sword.rarity}</div>
            <div class="char-name">${sword.name} (+${sword.attackBonus} ATK)</div>
            <div class="char-ability">${sword.description}</div>
        </div>
    `}).join('');

    const content = `
        <h1>Estoque de Espadas</h1>
        <p>Sua espada mais forte é equipada automaticamente para as batalhas.</p>
        <div class="roll-section card">
            <p style="font-size: 1.2em; margin-bottom: 10px;">Seu Saldo: <span style="color: #ffee58;">${userCoins}</span> moedas</p>
            <button id="roll-sword-btn" class="btn btn-info">Forjar Espada (${SWORD_ROLL_COST} moedas)</button>
        </div>
        <div class="characters-grid">${swordsHtml || '<p>Você ainda não tem espadas. Forje uma!</p>'}</div>

        <script>
            document.getElementById('roll-sword-btn').addEventListener('click', async () => {
                const rollButton = document.getElementById('roll-sword-btn');
                rollButton.disabled = true;
                rollButton.textContent = 'Forjando...';

                const response = await fetch('/api/sword/roll', { method: 'POST' });
                
                if (response.ok) {
                    const result = await response.json();
                    showNotification(\`Você forjou: \${result.name} (\${result.rarity})! Bônus: +\${result.attackBonus} ATK\`, 'success');
                    window.location.reload();
                } else {
                    const result = await response.json().catch(() => ({ message: 'Erro desconhecido.' }));
                    showNotification(result.message, 'error');
                    rollButton.disabled = false;
                    rollButton.textContent = 'Forjar Espada (' + SWORD_ROLL_COST + ' moedas)';
                }
            });
        </script>
    `;
    res.send(renderDashboardPage(req.session, 'Estoque de Espadas', content));
});

// --- API para Sortear Espada ---
app.post('/api/sword/roll', isAuthenticated, async (req, res) => {
    const userId = req.session.user.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user || user.coins < SWORD_ROLL_COST) {
        return res.status(402).json({ message: 'Moedas insuficientes! Você precisa de ' + SWORD_ROLL_COST + ' moedas para forjar.' });
    }

    const newSwordTemplate = rollSword();

    const [, createdSword] = await prisma.$transaction([
        prisma.user.update({
            where: { id: userId },
            data: { coins: { decrement: SWORD_ROLL_COST } },
        }),
        prisma.sword.create({
            data: { ...newSwordTemplate, ownerId: userId }
        })
    ]);

    res.status(200).json(createdSword);
});

// --- Página do Painel de Admin (Protegida) ---
app.get('/admin', isAuthenticated, isAdmin, async (req, res) => {
    // ✅ ADICIONADO: Bloco try...catch para evitar que o servidor trave (erro 502)
    try {
        // ✅ OTIMIZAÇÃO: Executa todas as consultas em paralelo para carregar a página mais rápido
        const [
            adminData,
            allUsers,
            allBannedUsers,
            openTickets, // Renomeado para clareza
            pendingAppeals, // Renomeado para clareza
            activeGiftLinks,
            adminLogs
        ] = await Promise.all([
            prisma.user.findUnique({ where: { id: req.session.user.id } }),
            prisma.user.findMany({ where: { isBanned: false }, orderBy: { username: 'asc' } }),
            prisma.user.findMany({ where: { isBanned: true }, orderBy: { username: 'asc' } }),
            prisma.ticket.findMany({ where: { status: TicketStatus.OPEN }, include: { author: true }, orderBy: { createdAt: 'desc' } }),
            prisma.banAppeal.findMany({ where: { status: AppealStatus.PENDING }, include: { user: true }, orderBy: { createdAt: 'desc' } }),
            prisma.giftLink.findMany({ where: { claimed: false, expiresAt: { gte: new Date() } }, orderBy: { createdAt: 'desc' } }),
            prisma.adminLog.findMany({ orderBy: { createdAt: 'desc' }, take: 20 })
        ]);

        let userListHtml = '';
        for (const userData of allUsers) {
        // Não mostra o próprio admin na lista de banimento
        if (userData.username !== process.env.ADMIN_USERNAME) {
            userListHtml += `
                <li class="user-list-item">
                    <div class="user-info">${userData.username} <span>(${userData.email})</span></div>
                    <form action="/api/admin/ban" method="POST" class="admin-form">
                        <input type="hidden" name="email" value="${userData.email}">
                        <input type="text" name="reason" placeholder="Motivo do banimento" required>
                        <button type="submit" class="btn-small btn-danger">Banir</button>
                    </form>
                    <form action="/api/admin/give-coins" method="POST" class="admin-form">
                        <input type="hidden" name="email" value="${userData.email}">
                        <input type="number" name="amount" placeholder="Doar Moedas" required min="1">
                        <button type="submit" class="btn-small btn-info">Doar</button>
                    </form>
                </li>
            `;
        }
    }
    
        let bannedUserListHtml = '';
        for (const userData of allBannedUsers) {
        bannedUserListHtml += `
            <li class="user-list-item">
                <div class="user-info">${userData.username} <span>(${userData.email})</span></div>
                <form action="/api/admin/unban" method="POST" class="admin-form">
                    <input type="hidden" name="email" value="${userData.email}">
                    <button type="submit" class="btn-small btn-success">Desbanir</button>
                </form>
            </li>
        `;
    }
    
        let openTicketsHtml = '';
        for (const ticket of openTickets) {
        openTicketsHtml += `
            <li class="user-list-item" style="flex-direction: column; align-items: flex-start;">
                <a href="/ticket/${ticket.id}" class="ticket-link" style="width: 100%;">
                    <div style="width: 100%; display: flex; justify-content: space-between; align-items: center;">
                        <strong>${ticket.subject}</strong>
                        <form action="/api/admin/tickets/close" method="POST" class="admin-form" onclick="event.stopPropagation()">
                            <input type="hidden" name="ticketId" value="${ticket.id}">
                            <button type="submit" class="btn-small btn-success">Fechar</button>
                        </form>
                    </div>
                </a>
                <small>De: ${ticket.author.username} (${ticket.author.email})</small>
            </li>
        `;
    }
    
        let adminLogsHtml = '';
        for (const log of adminLogs) {
        adminLogsHtml += `
            <li class="user-list-item" style="justify-content: flex-start; gap: 20px;">
                <span style="color: var(--admin-accent); font-weight: 600;">[${log.action}]</span>
                <span>${log.details}</span>
                <small style="margin-left: auto; color: var(--text-light-secondary);">
                    ${new Date(log.createdAt).toLocaleString('pt-BR')} por ${log.adminName}
                </small>
            </li>
        `;
    }
    
        let appealsHtml = '';
        for (const appeal of pendingAppeals) {
        appealsHtml += `
            <li class="user-list-item" style="flex-direction: column; align-items: flex-start;">
                <div class="user-info">${appeal.user.username} <span>(${appeal.user.email})</span></div>
                <p style="margin: 10px 0; color: var(--text-light-secondary); border-left: 2px solid var(--info-accent); padding-left: 10px;"><em>"${appeal.content}"</em></p>
                <div style="display: flex; gap: 10px; margin-top: 10px;">
                    <form action="/api/admin/appeals/approve" method="POST" class="admin-form">
                        <input type="hidden" name="appealId" value="${appeal.id}">
                        <button type="submit" class="btn-small btn-success">Aprovar (Desbanir)</button>
                    </form>
                    <form action="/api/admin/appeals/reject" method="POST" class="admin-form">
                        <input type="hidden" name="appealId" value="${appeal.id}">
                        <button type="submit" class="btn-small btn-danger">Rejeitar</button>
                    </form>
                </div>
            </li>
        `;
    }
    
        // Constrói a lista de personagens com a raridade incluída
        const allCharactersList = [];
        Object.values(charactersByRarity).flat().forEach(char => {
            const rarityKey = Object.keys(rarities).find(key => rarities[key].name.toUpperCase() === char.rarity?.name?.toUpperCase() || key === char.rarity);
            if (rarityKey) allCharactersList.push({ ...char, rarity: rarities[rarityKey] }); // Ensure rarity is an object
        });
        // Adiciona personagens exclusivos à lista de presente
        Object.values(exclusiveCharacters).forEach(char => {
            allCharactersList.push({ ...char, rarity: rarities[char.rarity] }); // Convert enum to full rarity object
        });

        const characterOptionsHtml = allCharactersList.map(char => `<option value="${char.name}">${char.name} (${char.rarity.name})</option>`).join('');
    
        let giftLinksHtml = '';
        for (const link of activeGiftLinks) {
        const fullLink = `${process.env.BASE_URL || `http://localhost:${port}`}/claim-gift?token=${link.token}`;
        let giftDescription = '';
        if (link.giftType === 'COINS') {
            giftDescription = `${link.giftValue} Moedas`;
        } else if (link.giftType === 'CHARACTER') {
            giftDescription = `Personagem: ${link.giftValue}`;
        }
        giftLinksHtml += `
            <li class="user-list-item">
                <span>Presente: <strong>${giftDescription}</strong></span>
                <input type="text" value="${fullLink}" readonly onclick="this.select()" style="flex-grow: 1; background: #1e1e1e; border: 1px solid #444; color: var(--text-light-primary); padding: 5px;">
            </li>
        `;
    }
    
        const content = `
        <h1 style="color: var(--admin-accent);">Painel do Administrador</h1>

        <div class="admin-section">
            <h2>Painel de Admin RPG</h2>
            <div class="card">
                <form id="admin-rpg-form">
                    <div class="form-group">
                        <label for="admin-attack">Ataque do Admin</label>
                        <input type="number" id="admin-attack" name="attack" required>
                    </div>
                    <div class="form-group">
                        <label for="admin-health">Vida do Admin</label>
                        <input type="number" id="admin-health" name="health" required>
                    </div>
                    <button type="submit" class="btn-small btn-info">Salvar Status</button>
                    <p id="rpg-status-message" style="margin-top: 10px;"></p>
                </form>
            </div>
        </div>

        <div class="admin-section">
            <h2>Gerenciar Moedas (Admin)</h2>
            <div class="card">
                <p>Seu saldo atual: <span style="color: #ffee58;">${adminData.coins}</span> moedas</p>
                <form action="/api/admin/give-coins" method="POST" class="admin-form">
                    <input type="hidden" name="email" value="${adminData.email}">
                    <input type="number" name="amount" placeholder="Quantidade para adicionar" required min="1">
                    <button type="submit" class="btn-small btn-info">Adicionar para mim</button>
                </form>
            </div>
        </div>

        <div class="admin-section">
            <h2>Gerar Links de Presente (Válido por 5 min)</h2>
            <div class="card">
                <form action="/api/admin/generate-gift-link" method="POST" class="admin-form" style="flex-direction: column; align-items: stretch;">
                    <div class="form-group">
                        <label for="giftType">Tipo de Presente</label>
                        <select name="giftType" id="giftType" onchange="toggleGiftValue()">
                            <option value="COINS">Moedas</option>
                            <option value="CHARACTER">Personagem</option>
                        </select>
                    </div>
                    <div id="coins-input" class="form-group">
                        <label for="coinsValue">Quantidade de Moedas</label>
                        <input type="number" name="coinsValue" placeholder="Ex: 500" min="1">
                    </div>
                    <div id="character-input" class="form-group" style="display: none;">
                        <label for="characterValue">Personagem</label>
                        <select name="characterValue">${characterOptionsHtml}</select>
                    </div>
                    <button type="submit" class="btn-small btn-info" style="width: 100%;">Gerar Link</button>
                </form>
            </div>
            <h3>Links Ativos</h3>
            <ul class="user-list">${giftLinksHtml || '<li class="user-list-item">Nenhum link de presente ativo.</li>'}</ul>
        </div>

        <div class="admin-section">
            <h2>Usuários Ativos</h2>
            <ul class="user-list" id="active-users-list">${userListHtml || '<li class="user-list-item">Nenhum usuário para gerenciar.</li>'}</ul>
            <template id="user-item-template">
                <li class="user-list-item">
                    <div class="user-info"></div>
                    <!-- Forms serão adicionados dinamicamente -->
                </li>
            </template>
        </div>
        <div class="admin-section">
            <h2>Usuários Banidos</h2>
            <ul class="user-list" id="banned-users-list">${bannedUserListHtml || '<li class="user-list-item">Nenhum usuário banido.</li>'}</ul>
        </div>

        <div class="admin-section">
            <h2 style="color: var(--info-accent);">Tickets Abertos</h2>
            <ul class="user-list" id="open-tickets-list">${openTicketsHtml || '<li class="user-list-item">Nenhum ticket aberto.</li>'}</ul>
        </div>

        <div class="admin-section">
            <h2 style="color: var(--info-accent);">Apelos de Banimento</h2>
            <ul class="user-list" id="ban-appeals-list">${appealsHtml || '<li class="user-list-item">Nenhum apelo pendente.</li>'}</ul>
        </div>

        <div class="admin-section">
            <h2 style="color: #bdc3c7;">Log de Ações Recentes</h2>
            <ul class="user-list">${adminLogsHtml || '<li class="user-list-item">Nenhuma ação registrada.</li>'}</ul>
        </div>
    `;
    
        const adminScript = `
        function toggleGiftValue() {
            const giftType = document.getElementById('giftType').value;
            const coinsInput = document.getElementById('coins-input');
            const charInput = document.getElementById('character-input');
            if (giftType === 'COINS') {
                coinsInput.style.display = 'block';
                charInput.style.display = 'none';
                coinsInput.querySelector('input').required = true;
                charInput.querySelector('select').required = false;
            } else {
                coinsInput.style.display = 'none';
                charInput.style.display = 'block';
                coinsInput.querySelector('input').required = false;
                charInput.querySelector('select').required = true;
            }
        }
        toggleGiftValue(); // Run on page load

        // --- Lógica do Painel de Admin RPG ---
        const rpgForm = document.getElementById('admin-rpg-form');
        const attackInput = document.getElementById('admin-attack');
        const healthInput = document.getElementById('admin-health');
        const rpgStatusMsg = document.getElementById('rpg-status-message');

        // Carrega os status atuais ao abrir a página
        async function loadAdminStats() {
            try {
                const response = await fetch('/api/admin/stats');
                if (!response.ok) throw new Error('Falha ao carregar status.');
                const stats = await response.json();
                attackInput.value = stats.attack;
                healthInput.value = stats.health;
            } catch (error) {
                rpgStatusMsg.textContent = error.message;
                rpgStatusMsg.style.color = 'var(--danger-accent)';
            }
        }
        loadAdminStats();

        // Salva os novos status
        rpgForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const attack = parseInt(attackInput.value, 10);
            const health = parseInt(healthInput.value, 10);

            try {
                const response = await fetch('/api/admin/stats', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ attack, health })
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || 'Erro desconhecido.');
                
                rpgStatusMsg.textContent = result.message;
                rpgStatusMsg.style.color = 'var(--success-accent)';
            } catch (error) {
                rpgStatusMsg.textContent = error.message;
                rpgStatusMsg.style.color = 'var(--danger-accent)';
            }
        });


        socket.emit('join admin room'); // Admin entra na sala de notificações

        // --- Real-time para Tickets ---
        socket.on('new ticket', (ticket) => {
            const list = document.getElementById('open-tickets-list');
            const newItem = document.createElement('li');
            newItem.className = 'user-list-item';
            newItem.style.flexDirection = 'column';
            newItem.style.alignItems = 'flex-start';
            newItem.innerHTML = \`
                <a href="/ticket/\${ticket.id}" class="ticket-link" style="width: 100%;">
                    <div style="width: 100%; display: flex; justify-content: space-between; align-items: center;">
                        <strong>\${ticket.subject}</strong>
                        <form action="/api/admin/tickets/close" method="POST" class="admin-form" onclick="event.stopPropagation()">
                            <input type="hidden" name="ticketId" value="\${ticket.id}">
                            <button type="submit" class="btn-small btn-success">Fechar</button>
                        </form>
                    </div>
                </a>
                <small>De: \${ticket.author.username} (\${ticket.author.email})</small>
            \`;
            if (list.querySelector('.user-list-item').textContent.includes('Nenhum ticket')) {
                list.innerHTML = ''; // Limpa a mensagem "Nenhum ticket"
            }
            list.prepend(newItem);
        });

        // --- Real-time para Apelos ---
        socket.on('new appeal', (appeal) => {
            const list = document.getElementById('ban-appeals-list');
            const newItem = document.createElement('li');
            newItem.className = 'user-list-item';
            newItem.style.flexDirection = 'column';
            newItem.style.alignItems = 'flex-start';
            newItem.id = 'appeal-' + appeal.id;
            newItem.innerHTML = \`
                <div class="user-info">\${appeal.user.username} <span>(\${appeal.user.email})</span></div>
                <p style="margin: 10px 0; color: var(--text-light-secondary); border-left: 2px solid var(--info-accent); padding-left: 10px;"><em>"\${appeal.content}"</em></p>
                <div style="display: flex; gap: 10px; margin-top: 10px;">
                    <form action="/api/admin/appeals/approve" method="POST" class="admin-form">
                        <input type="hidden" name="appealId" value="\${appeal.id}">
                        <button type="submit" class="btn-small btn-success">Aprovar (Desbanir)</button>
                    </form>
                    <form action="/api/admin/appeals/reject" method="POST" class="admin-form">
                        <input type="hidden" name="appealId" value="\${appeal.id}">
                        <button type="submit" class="btn-small btn-danger">Rejeitar</button>
                    </form>
                </div>
            \`;
            if (list.querySelector('.user-list-item').textContent.includes('Nenhum apelo')) {
                list.innerHTML = '';
            }
            list.prepend(newItem);
        });

        // --- Real-time para Desbanimento Direto ---
        document.getElementById('banned-users-list').addEventListener('submit', async (e) => {
            if (e.target.action.includes('/api/admin/unban')) {
                e.preventDefault();
                const form = e.target;
                const email = form.email.value;
                const response = await fetch(form.action, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email })
                });

                if (response.ok) {
                    const { unbannedUser } = await response.json();
                    // Remove o usuário da lista de banidos e adiciona na de ativos
                    moveUserToActiveList(unbannedUser);
                }
            }
        });

        // --- Real-time para Desbanimento (via aprovação de apelo) ---
        document.body.addEventListener('submit', async (e) => {
            if (e.target.action.includes('/api/admin/appeals/approve')) {
                e.preventDefault();
                const form = e.target;
                const appealId = form.appealId.value;
                const response = await fetch(form.action, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ appealId })
                });
                if (response.ok) {
                    const { unbannedUser } = await response.json();
                    // Remove o apelo da lista
                    document.getElementById('appeal-' + appealId)?.remove();
                    moveUserToActiveList(unbannedUser);
                } else {
                    showNotification('Falha ao aprovar apelo.', 'error');
                }
            }
        });

        function moveUserToActiveList(user) {
            // Remove o usuário da lista de banidos (se existir)
            const bannedList = document.getElementById('banned-users-list');
            const bannedUserItem = Array.from(bannedList.querySelectorAll('.user-list-item')).find(item => item.querySelector('input[name="email"]')?.value === user.email);
            bannedUserItem?.remove();

            // Adiciona o usuário à lista de ativos
            const activeList = document.getElementById('active-users-list');
            const template = document.getElementById('user-item-template');
            const clone = template.content.cloneNode(true);
            clone.querySelector('.user-info').innerHTML = \`\${user.username} <span>(\${user.email})</span>\`;
            // TODO: Adicionar forms de ban e give coins aqui se necessário no futuro
            activeList.prepend(clone);
        }
    `;
    
        res.send(renderDashboardPage(req.session, 'Admin Panel', content, adminScript));
    } catch (error) {
        console.error("ERRO CRÍTICO AO CARREGAR O PAINEL DE ADMIN:", error);
        res.status(500).send('<h1>Erro 500 - Falha Interna do Servidor</h1><p>Ocorreu um erro ao carregar os dados do painel de administrador. Verifique os logs do servidor para mais detalhes.</p>');
    }
});

app.post('/api/admin/tickets/close', isAuthenticated, isAdmin, async (req, res) => {
    const { ticketId } = req.body;
    const ticket = await prisma.ticket.update({
        where: { id: parseInt(ticketId, 10) },
        // ✅ CORREÇÃO: Usando o enum em vez da string para evitar o erro.
        data: { status: TicketStatus.CLOSED },
        include: { author: true },
    });

    if (ticket) {
        await logAdminAction(req.session.user.username, 'CLOSE_TICKET', `Fechou o ticket #${ticketId} de ${ticket.author.username}.`);
    }
    res.redirect('/admin');
});

// --- API para Doar/Adicionar Moedas (Admin) ---
app.post('/api/admin/give-coins', isAuthenticated, isAdmin, async (req, res) => {
    const { email, amount } = req.body;
    const amountNumber = parseInt(amount, 10);

    if (!email || isNaN(amountNumber) || amountNumber <= 0) {
        return res.status(400).send('Email e uma quantidade válida de moedas são necessários.');
    }

    try {
        const targetUser = await prisma.user.findUnique({ where: { email } });
        if (!targetUser) return res.status(404).send('Usuário não encontrado.');

        const updatedUser = await prisma.user.update({ where: { email }, data: { coins: { increment: amountNumber } } });
        const logDetails = email === req.session.user.email ? `Adicionou ${amountNumber} moedas para si mesmo.` : `Doou ${amountNumber} moedas para ${updatedUser.username}.`;
        await logAdminAction(req.session.user.username, 'GIVE_COINS', logDetails);
        res.redirect('/admin');
    } catch (error) {
        console.error("Erro ao doar moedas:", error);
        res.status(500).send('Erro interno ao processar a doação.');
    }
});


// --- Rota para Banir Usuário ---
app.post('/api/admin/ban', isAuthenticated, isAdmin, async (req, res) => {
    const { email, reason } = req.body;
    try {
        const userToBan = await prisma.user.update({
            where: { email },
            data: { isBanned: true, banReason: reason },
        });

        if (userToBan) {
            await logAdminAction(req.session.user.username, 'BAN_USER', `Baniu o usuário ${userToBan.username} (${email}). Motivo: ${reason}`);

            // Emite um evento de banimento para o usuário específico
            io.to(email).emit('banned', { reason: reason });

            // Envia e-mail de notificação de banimento
            const appealLink = `${process.env.BASE_URL || `http://localhost:${port}`}/appeal?userId=${userToBan.id}`;
            const emailHtml = createStyledEmail({
                title: 'Sua Conta Foi Banida',
                bodyContent: `
                    <p style="color: #b3b3b3; font-size: 16px; line-height: 24px;">Olá, ${userToBan.username}.</p>
                    <p style="color: #b3b3b3; font-size: 16px; line-height: 24px;">Sua conta no uberzer foi banida. Abaixo estão os detalhes:</p>
                    <div style="background-color: #2a2a2a; padding: 15px; border-radius: 8px; margin: 20px 0; color: #e0e0e0;"><strong>Motivo:</strong> ${reason}</div>
                    <p style="color: #b3b3b3; font-size: 16px; line-height: 24px;">Se você acredita que isso foi um erro, você pode fazer um apelo clicando no botão abaixo.</p>
                `,
                button: { text: 'Apelar do Banimento', link: appealLink }
            });

            sgMail.send({ to: email, from: { name: 'Suporte uberzer', email: process.env.EMAIL_USER }, subject: 'Notificação de Banimento - uberzer', html: emailHtml })
                .catch(err => console.error("Erro ao enviar e-mail de notificação de banimento:", err));
        }
        res.redirect('/admin');
    } catch (error) {
        console.error("Erro ao banir usuário:", error);
        res.status(500).send('Erro interno ao processar o banimento.');
    }
});

app.post('/api/admin/unban', isAuthenticated, isAdmin, async (req, res) => {
    const { email } = req.body;
    try {
        const unbannedUser = await prisma.user.update({
            where: { email },
            data: { isBanned: false, banReason: null },
        });
        if (unbannedUser) {
            await logAdminAction(req.session.user.username, 'UNBAN_USER', `Desbaniu o usuário ${unbannedUser.username} (${email}).`);

            const emailHtml = createStyledEmail({
                title: 'Sua Conta Foi Reativada',
                bodyContent: `<p style="color: #b3b3b3; font-size: 16px; line-height: 24px;">Olá, ${unbannedUser.username}.</p><p style="color: #b3b3b3; font-size: 16px; line-height: 24px;">Boas notícias! Sua conta no uberzer foi reativada. Você já pode fazer login novamente.</p>`,
                button: { text: 'Acessar o Site', link: process.env.BASE_URL || `http://localhost:${port}` }
            });
            sgMail.send({ to: email, from: { name: 'Suporte uberzer', email: process.env.EMAIL_USER }, subject: 'Sua conta foi reativada - uberzer', html: emailHtml })
                .catch(err => console.error("Erro ao enviar e-mail de notificação de desbanimento:", err));
        }
        res.json({ success: true, unbannedUser });
    } catch (error) {
        console.error("Erro ao desbanir usuário:", error);
        res.status(500).json({ success: false, message: 'Erro interno ao processar o desbanimento.' });
    }
});

// --- Rotas do Sistema de Links de Presente ---

app.post('/api/admin/generate-gift-link', isAuthenticated, isAdmin, async (req, res) => {
    const { giftType, coinsValue, characterValue } = req.body;

    let giftValue;
    let giftMeta = null;

    if (giftType === 'COINS') {
        giftValue = parseInt(coinsValue, 10).toString();
        if (isNaN(giftValue) || giftValue <= 0) {
            return res.status(400).send('Quantidade de moedas inválida.');
        }
    } else if (giftType === 'CHARACTER') {
        giftValue = characterValue;
        // ✅ CORREÇÃO: Procura o personagem tanto nos normais quanto nos exclusivos.
        const charInfo = exclusiveCharacters[giftValue] || Object.values(charactersByRarity).flat().find(c => c.name === giftValue);
        
        if (!charInfo) {
            return res.status(400).send('Personagem inválido.');
        }

        // Checa se é um personagem exclusivo
        const exclusiveChar = exclusiveCharacters[giftValue];
        if (exclusiveChar) {
            giftMeta = JSON.stringify({ rarity: exclusiveChar.rarity });
        } else {
            // Lógica para personagens normais
        const rarityKey = Object.keys(charactersByRarity).find(key => charactersByRarity[key].some(c => c.name === giftValue));
        const rarityInfo = rarities[rarityKey];

        giftMeta = JSON.stringify({ rarity: rarityInfo.name }); // Salva o nome da raridade para exibir na tela de resgate
        }
    } else {
        return res.status(400).send('Tipo de presente inválido.');
    }

    const token = randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutos de validade

    await prisma.giftLink.create({
        data: { token, giftType, giftValue, giftMeta, expiresAt }
    });

    await logAdminAction(req.session.user.username, 'CREATE_GIFT_LINK', `Gerou um link de presente: ${giftType} - ${giftValue}`);

    res.redirect('/admin');
});

app.get('/claim-gift', isAuthenticated, async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).send('Token não fornecido.');

    const giftLink = await prisma.giftLink.findUnique({ where: { token } });

    if (!giftLink || giftLink.claimed || giftLink.expiresAt < new Date()) {
        return res.send(renderAuthPage('Presente Inválido', '<div class="auth-container"><h1>Presente Inválido</h1><p>Este link de presente é inválido, já foi resgatado ou expirou.</p></div>'));
    }

    let giftDescription = '';
    if (giftLink.giftType === 'COINS') {
        giftDescription = `<strong>${giftLink.giftValue} Moedas</strong>`;
    } else {
        let rarityName = '';
        try {
            const meta = JSON.parse(giftLink.giftMeta);
            rarityName = meta.rarity;
        } catch (e) {
            rarityName = 'Raridade desconhecida';
        }
        giftDescription = `o personagem <strong style="color: var(--info-accent);">${giftLink.giftValue}</strong> (${rarityName})`;
    }

    const content = `
        <div class="auth-container">
            <h1>Você Recebeu um Presente!</h1>
            <p>Você está prestes a resgatar ${giftDescription}.</p>
            <form action="/api/claim-gift" method="POST">
                <input type="hidden" name="token" value="${token}">
                <button type="submit" class="btn">Resgatar Presente</button>
            </form>
        </div>
    `;
    res.send(renderAuthPage('Resgatar Presente', content));
});

app.post('/api/claim-gift', isAuthenticated, async (req, res) => {
    const { token } = req.body;
    const userId = req.session.user.id;

    try {
        const giftLink = await prisma.giftLink.findFirst({
            where: { token, claimed: false, expiresAt: { gte: new Date() } }
        });

        if (!giftLink) {
            return res.status(400).send('<h1>Erro</h1><p>Este presente não pôde ser resgatado (inválido, expirado ou já resgatado).</p>');
        }

        let isJacket = false;
        let isRatoMaromba = false;

        if (giftLink.giftType === 'COINS') {
            await prisma.user.update({ where: { id: userId }, data: { coins: { increment: parseInt(giftLink.giftValue) } } });
            // ✅ CORREÇÃO: Envia a resposta e encerra a função aqui para evitar erros.
            await prisma.giftLink.update({ where: { id: giftLink.id }, data: { claimed: true, claimedByUserId: userId } });
            return res.send(`
                <h1>Presente Resgatado!</h1>
                <p>O presente foi adicionado à sua conta.</p>
                <p><a href="/dashboard">Voltar ao Dashboard</a></p>
            `);
        } else if (giftLink.giftType === 'CHARACTER') {
            // Procura primeiro nos exclusivos, depois nos normais
            let charInfo = exclusiveCharacters[giftLink.giftValue] || Object.values(charactersByRarity).flat().find(c => c.name === giftLink.giftValue);

            if (charInfo) {
                if (charInfo.name === 'Jacket') {
                    isJacket = true;
                }
                if (charInfo.name === 'RATO MAROMBA') {
                    isRatoMaromba = true;
                }

                // ✅ CORREÇÃO: Encontra a chave da raridade (ex: 'COMUM') de forma segura.
                const rarityKey = Object.keys(Rarity).find(key => key === charInfo.rarity) || 
                                  Object.keys(charactersByRarity).find(key => charactersByRarity[key].some(c => c.name === charInfo.name));
                const rarityInfo = rarities[rarityKey]; // Pega o objeto de raridade completo (nome, cor, etc.)

                await prisma.character.create({
                    data: {
                        name: charInfo.name,
                        ability: charInfo.ability,
                        rarity: Rarity[rarityKey],
                        rarityColor: rarityInfo.color,
                        buffDescription: charInfo.buff ? charInfo.buff.description : null,
                        attack: charInfo.attack || 10,
                        health: charInfo.health || 100,
                        ownerId: userId
                    }
                });
            }
        }

        await prisma.giftLink.update({ where: { id: giftLink.id }, data: { claimed: true, claimedByUserId: userId } });

        if (isJacket) {
            // ✅ Envia a página da cutscene especial do Jacket
            res.send(`
                <!DOCTYPE html>
                <html lang="pt-BR">
                <head>
                    <meta charset="UTF-8">
                    <title>...</title>
                    <style>
                        @import url('https://fonts.googleapis.com/css2?family=VT323&display=swap');
                        body { background-color: #000; color: #fff; font-family: 'VT323', monospace; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; overflow: hidden; }
                        .cutscene { text-align: center; }
                        .line { font-size: 5vw; line-height: 1.2; text-shadow: 0 0 5px #ff00ff, 0 0 10px #ff00ff, 0 0 20px #ff00ff, 0 0 40px #00ffff, 0 0 60px #00ffff; opacity: 0; animation: fadeIn 1s forwards, flicker 0.1s infinite alternate; }
                        #line1 { animation-delay: 1s; }
                        #line2 { animation-delay: 2.5s; }
                        #line3 { animation-delay: 4s; }
                        #line4 { animation-delay: 5.5s; }
                        #final-message { font-size: 2vw; opacity: 0; animation: fadeIn 2s 7s forwards; color: #f1c40f; }
                        @keyframes fadeIn { to { opacity: 1; } }
                        @keyframes flicker { from { opacity: 0.95; } to { opacity: 1; } }
                    </style>
                </head>
                <body>
                    <div class="cutscene">
                        <div id="line1" class="line">Do you know</div>
                        <div id="line2" class="line">what time</div>
                        <div id="line3" class="line">it is?</div>
                        <div id="line4" class="line" style="color: #f1c40f; text-shadow: 0 0 10px #f1c40f, 0 0 20px #f1c40f;">...It's time to hurt other people.</div>
                        <div id="final-message">
                            <p>Personagem 'Jacket' foi adicionado à sua conta.</p>
                            <p><a href="/dashboard" style="color: #fff; text-decoration: underline;">Voltar ao Dashboard</a></p>
                        </div>
                    </div>
                    <audio autoplay loop><source src="/audio/jacket-theme.mp3" type="audio/mpeg"></audio>
                </body>
                </html>
            `);
        } else if (isRatoMaromba) {
            res.send(`
                <!DOCTYPE html>
                <html lang="pt-BR">
                <head>
                    <meta charset="UTF-8">
                    <title>SHAPE INEXPLICÁVEL</title>
                    <style>
                        @import url('https://fonts.googleapis.com/css2?family=Impact&display=swap');
                        body {
                            background: radial-gradient(ellipse at center, #444 0%, #111 70%);
                            color: #fff; font-family: 'Impact', sans-serif;
                            display: flex; justify-content: center; align-items: center;
                            height: 100vh; margin: 0; overflow: hidden; text-align: center;
                        }
                        .line {
                            font-size: 7vw; line-height: 1.2; text-transform: uppercase;
                            text-shadow: 4px 4px 0 #000, 0 0 20px rgba(0,0,0,0.8);
                            opacity: 0;
                            animation: dropIn 0.5s cubic-bezier(0.5, 0, 0.1, 1) forwards, pump 2s ease-in-out infinite 1s;
                        }
                        #line1 { animation-delay: 0.5s; }
                        #line2 { color: #f1c40f; animation-delay: 2.0s; }
                        #line3 { font-size: 10vw; color: #e74c3c; animation: dropIn 0.5s 3.5s forwards, screenShake 0.8s 3.5s forwards; }
                        #final-message { font-size: 1.5vw; opacity: 0; animation: fadeIn 1s 5s forwards; font-family: 'Poppins', sans-serif; }
                        @keyframes dropIn { from { transform: translateY(-100px) scale(1.2); opacity: 0; } to { transform: translateY(0) scale(1); opacity: 1; } }
                        @keyframes pump { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
                        @keyframes screenShake { 0%, 100% { transform: translate(0, 0) rotate(0); } 20% { transform: translate(-5px, 5px) rotate(-1deg); } 40% { transform: translate(5px, -5px) rotate(1deg); } 60% { transform: translate(-5px, 5px) rotate(0deg); } 80% { transform: translate(5px, -5px) rotate(-1deg); } }
                        @keyframes fadeIn { to { opacity: 1; } }
                    </style>
                </head>
                <body>
                    <div>
                        <div id="line1" class="line">EAE, FRANGO...</div>
                        <div id="line2" class="line">QUER FICAR MONSTRÃO?</div>
                        <div id="line3" class="line">BIIIRL!</div>
                        <div id="final-message">
                            <p>Personagem 'RATO MAROMBA' foi adicionado à sua conta.</p>
                            <p><a href="/dashboard" style="color: #f1c40f; text-decoration: underline;">VOLTAR PRA JAULA</a></p>
                        </div>
                    </div>
                    <audio autoplay><source src="/audio/rato-maromba-theme.mp3" type="audio/mpeg"></audio>
                </body>
                </html>
            `);
        } else {
            // Resposta padrão para outros presentes
            res.send(`
                <h1>Presente Resgatado!</h1>
                <p>O presente foi adicionado à sua conta.</p>
                <p><a href="/dashboard">Voltar ao Dashboard</a></p>
            `);
        }

    } catch (error) {
        console.error("Erro ao resgatar presente:", error);
        res.status(500).send('<h1>Erro Interno</h1><p>Ocorreu um erro ao processar seu resgate. Tente novamente mais tarde.</p>');
    }
});

// --- Rotas do Sistema de Apelação ---

app.get('/appeal', async (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).send('Link de apelo inválido.');

    const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { appeal: true }
    });

    if (!user || !user.isBanned) {
        return res.status(404).send('Usuário não encontrado ou não está banido.');
    }

    const existingAppeal = user.appeal;

    let content;
    if (existingAppeal) {
        content = `
            <div class="auth-container">
                <h1>Apelo já Enviado</h1>
                <p style="color: #aaa; margin-bottom: 20px;">Olá, <strong>${user.username}</strong>. Já recebemos seu apelo e ele está sendo analisado por nossa equipe.</p>
                <p>Status atual: <strong>${existingAppeal.status}</strong></p>
            </div>
        `;
    } else {
        content = `
            <div class="auth-container">
                <h1>Apelação de Banimento</h1>
                <p style="color: #aaa; margin-bottom: 20px;">Olá, <strong>${user.username}</strong>. Para solicitar a reativação da sua conta, escreva seu apelo e confirme que você leu e concorda em seguir as regras.</p>
                <form id="appeal-form" action="/api/appeal" method="POST">
                    <input type="hidden" name="userId" value="${userId}">
                    <div class="form-group">
                        <textarea name="content" rows="8" required placeholder="Escreva seu apelo aqui..."></textarea>
                    </div>
                    <div class="form-group" style="text-align: left; display: flex; align-items: center; gap: 10px;">
                        <input type="checkbox" id="terms" name="terms" required>
                        <label for="terms" style="margin: 0;">Eu li as regras e concordo em não repetir a infração.</label>
                    </div>
                    <button type="submit" class="btn">Solicitar Reativação</button>
                </form>
            </div>
        `;
    }

    res.send(renderAuthPage('Apelação de Banimento', content));
});

app.post('/api/appeal', async (req, res) => {
    const { userId, content } = req.body;
    const newAppeal = await prisma.banAppeal.create({
        data: {
            content,
            userId
        },
        include: { user: true }
    });

    // Notifica os admins em tempo real
    io.to('admin-room').emit('new appeal', newAppeal);

    res.send('<h1>Apelo Enviado</h1><p>Seu apelo foi enviado com sucesso e será analisado pela nossa equipe.</p>');
});

app.post('/api/admin/appeals/approve', isAuthenticated, isAdmin, async (req, res) => {
    // ✅ ADICIONADO: Bloco try...catch para evitar o erro 502
    try {
        const { appealId } = req.body;
        const appeal = await prisma.banAppeal.update({
            where: { id: parseInt(appealId) },
            // ✅ CORREÇÃO: Usando o enum em vez da string
            data: { status: AppealStatus.APPROVED },
            include: { user: true }
        });

        if (appeal) {
            const unbannedUser = await prisma.user.update({ where: { id: appeal.userId }, data: { isBanned: false, banReason: null } });
            await logAdminAction(req.session.user.username, 'APPROVE_APPEAL', `Aprovou o apelo e desbaniu o usuário ${appeal.user.username}.`);

            // Envia e-mail de notificação de apelo aprovado
            const emailHtml = createStyledEmail({
                title: 'Seu Apelo Foi Aprovado',
                bodyContent: `<p style="color: #b3b3b3; font-size: 16px; line-height: 24px;">Olá, ${appeal.user.username}.</p><p style="color: #b3b3b3; font-size: 16px; line-height: 24px;">Boas notícias! Após análise, seu apelo de banimento foi aprovado e sua conta foi reativada. Seja bem-vindo de volta!</p>`,
                button: { text: 'Acessar o Site', link: process.env.BASE_URL || `http://localhost:${port}` }
            });

            sgMail.send({ to: appeal.user.email, from: { name: 'Suporte uberzer', email: process.env.EMAIL_USER }, subject: 'Apelo Aprovado - uberzer', html: emailHtml })
                .catch(err => console.error("Erro ao enviar e-mail de apelo aprovado:", err));
            
            res.json({ success: true, unbannedUser });
        } else {
            res.status(404).json({ success: false, message: 'Apelo não encontrado.' });
        }
    } catch (error) {
        console.error("Erro ao aprovar apelo:", error);
        res.status(500).json({ success: false, message: 'Erro interno ao processar a aprovação.' });
    }
});

app.post('/api/admin/appeals/reject', isAuthenticated, isAdmin, async (req, res) => {
    const { appealId } = req.body;
    const appeal = await prisma.banAppeal.update({
        where: { id: parseInt(appealId) },
        // ✅ CORREÇÃO: Usando o enum em vez da string
        data: { status: AppealStatus.REJECTED },
        include: { user: true }
    });
    if (appeal) {
        await logAdminAction(req.session.user.username, 'REJECT_APPEAL', `Rejeitou o apelo do usuário ${appeal.user.username}.`);
    }
    res.redirect('/admin');
});

// --- NOVAS ROTAS E LÓGICA DE RPG ---

// Rota para OBTER os status atuais do admin
app.get('/api/admin/stats', isAuthenticated, isAdmin, async (req, res) => {
    try {
      // Busca os status do admin. Usamos upsert para criar se não existir.
      const adminStats = await prisma.adminStats.upsert({
        where: { id: 1 },
        update: {},
        create: { id: 1, attack: 999, health: 9999 },
      });
      res.json(adminStats);
    } catch (error) {
      console.error("Erro ao buscar status do admin:", error);
      res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});
  
// Rota para DEFINIR os status do admin
app.post('/api/admin/stats', isAuthenticated, isAdmin, async (req, res) => {
    const { attack, health } = req.body;
  
    // Validação
    if (typeof attack !== 'number' || typeof health !== 'number' || attack < 0 || health < 0) {
      return res.status(400).json({ error: 'Ataque e vida devem ser números positivos.' });
    }
  
    try {
      const updatedStats = await prisma.adminStats.upsert({
        where: { id: 1 },
        update: { attack, health },
        create: { id: 1, attack, health },
      });
      await logAdminAction(req.session.user.username, 'UPDATE_ADMIN_STATS', `Atualizou os status de RPG do admin para Ataque: ${attack}, Vida: ${health}.`);
      res.json({ message: 'Status do admin atualizados com sucesso!', stats: updatedStats });
    } catch (error) {
      console.error("Erro ao atualizar status do admin:", error);
      res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// --- SISTEMA DE AMIGOS ---

app.get('/friends', isAuthenticated, async (req, res) => {
    const userId = req.session.user.id;

    const friendships = await prisma.friendship.findMany({
        where: {
            OR: [{ requesterId: userId }, { receiverId: userId }],
            status: 'ACCEPTED'
        },
        include: {
            requester: { select: { id: true, username: true, profilePictureUrl: true } },
            receiver: { select: { id: true, username: true, profilePictureUrl: true } }
        }
    });

    const friends = friendships.map(f => {
        return f.requesterId === userId ? f.receiver : f.requester;
    });

    const pendingRequests = await prisma.friendship.findMany({
        where: {
            receiverId: userId,
            status: 'PENDING'
        },
        include: {
            requester: { select: { id: true, username: true, profilePictureUrl: true } }
        }
    });

    const friendsHtml = friends.map(friend => {
        const profilePic = friend.profilePictureUrl || 'https://via.placeholder.com/40?text=?';
        return `
            <li class="user-list-item">
                <img src="${profilePic}" alt="Foto de ${friend.username}" class="friend-list-pfp">
                <span>${friend.username}</span>
                <div>
                    <a href="/chat/${friend.id}" class="btn-small btn-info" style="text-decoration: none;">Conversar</a>
                    <form action="/api/friends/remove" method="POST" style="display: inline;">
                        <input type="hidden" name="friendId" value="${friend.id}">
                        <button type="submit" class="btn-small btn-danger">Remover</button>
                    </form>
                </div>
            </li>
        `}).join('') || '<li class="user-list-item">Você não tem amigos ainda.</li>';

    const requestsHtml = pendingRequests.map(req => {
        const profilePic = req.requester.profilePictureUrl || 'https://via.placeholder.com/40?text=?';
        return `
            <li class="user-list-item">
                <img src="${profilePic}" alt="Foto de ${req.requester.username}" class="friend-list-pfp">
                <span>${req.requester.username}</span>
                <div>
                <form action="/api/friends/accept" method="POST" style="display: inline;">
                    <input type="hidden" name="requesterId" value="${req.requester.id}">
                    <button type="submit" class="btn-small btn-success">Aceitar</button>
                </form>
                <form action="/api/friends/reject" method="POST" style="display: inline;">
                    <input type="hidden" name="requesterId" value="${req.requester.id}">
                    <button type="submit" class="btn-small btn-danger">Rejeitar</button>
                </form>
            </div>
        </li>`
    }).join('') || '<li class="user-list-item">Nenhum pedido de amizade.</li>';

    const content = `
        <h1>Amigos</h1>
        <div class="admin-section">
            <h2>Adicionar Amigo</h2>
            <div class="card">
                <form id="add-friend-form">
                    <div class="form-group">
                        <label for="friend-name">Nome de usuário</label>
                        <input type="text" id="friend-name" name="username" required placeholder="Digite o nome do usuário...">
                    </div>
                    <button type="submit" class="btn">Enviar Pedido</button>
                </form>
            </div>
        </div>

        <div class="admin-section">
            <h2>Pedidos Pendentes</h2>
            <ul class="user-list">${requestsHtml}</ul>
        </div>

        <div class="admin-section">
            <h2>Sua Lista de Amigos</h2>
            <ul class="user-list">${friendsHtml}</ul>
        </div>
    `;

    const pageScript = `
        document.getElementById('add-friend-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = e.target.username.value;
            const response = await fetch('/api/friends/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username })
            });
            const data = await response.json();
            if (response.ok) {
                showNotification(data.message, 'success');
                e.target.username.value = '';
            } else {
                showNotification(data.message, 'error');
            }
        });
    `;

    res.send(renderDashboardPage(req.session, 'Amigos', content, pageScript));
});

app.post('/api/friends/add', isAuthenticated, async (req, res) => {
    const { username } = req.body;
    const requesterId = req.session.user.id;

    const receiver = await prisma.user.findUnique({ where: { username } });

    if (!receiver) {
        return res.status(404).json({ message: 'Usuário não encontrado.' });
    }
    if (receiver.id === requesterId) {
        return res.status(400).json({ message: 'Você não pode adicionar a si mesmo.' });
    }

    // Checa se já existe uma amizade, em qualquer direção
    const existingFriendship = await prisma.friendship.findFirst({
        where: {
            OR: [
                { requesterId: requesterId, receiverId: receiver.id },
                { requesterId: receiver.id, receiverId: requesterId }
            ]
        }
    });

    if (existingFriendship) {
        if (existingFriendship.status === 'ACCEPTED') {
            return res.status(400).json({ message: 'Você já é amigo deste usuário.' });
        }
        return res.status(400).json({ message: 'Um pedido de amizade já existe com este usuário.' });
    }

    await prisma.friendship.create({
        data: {
            requesterId: requesterId,
            receiverId: receiver.id,
        }
    });

    // Notifica o usuário em tempo real
    const receiverSocketId = onlineUsers.get(receiver.email);
    if (receiverSocketId) {
        io.to(receiverSocketId).emit('friend_request', { from: req.session.user.username });
    }

    res.json({ message: 'Pedido de amizade enviado!' });
});

app.post('/api/friends/accept', isAuthenticated, async (req, res) => {
    const { requesterId } = req.body;
    const receiverId = req.session.user.id;

    await prisma.friendship.update({
        where: {
            requesterId_receiverId: {
                requesterId: requesterId,
                receiverId: receiverId
            }
        },
        data: { status: 'ACCEPTED' }
    });

    res.redirect('/friends');
});

app.post('/api/friends/reject', isAuthenticated, async (req, res) => {
    const { requesterId } = req.body;
    const receiverId = req.session.user.id;

    await prisma.friendship.delete({
        where: {
            requesterId_receiverId: {
                requesterId: requesterId,
                receiverId: receiverId
            }
        }
    });

    res.redirect('/friends');
});

app.post('/api/friends/remove', isAuthenticated, async (req, res) => {
    const { friendId } = req.body;
    const userId = req.session.user.id;

    await prisma.friendship.deleteMany({
        where: {
            status: 'ACCEPTED',
            OR: [
                { requesterId: userId, receiverId: friendId },
                { requesterId: friendId, receiverId: userId }
            ]
        }
    });

    res.redirect('/friends');
});

app.get('/chat/:friendId', isAuthenticated, async (req, res) => {
    const userId = req.session.user.id;
    const friendId = req.params.friendId;

    const friend = await prisma.user.findUnique({ where: { id: friendId } });
    if (!friend) {
        return res.status(404).send("Amigo não encontrado.");
    }

    // Carregar histórico de mensagens
    const messages = await prisma.privateMessage.findMany({
        where: {
            OR: [
                { senderId: userId, receiverId: friendId },
                { senderId: friendId, receiverId: userId }
            ]
        },
        orderBy: { createdAt: 'asc' },
        include: { sender: { select: { username: true } } }
    });

    const messagesHtml = messages.map(msg => {
        const isMe = msg.senderId === userId;
        return `<li class="${isMe ? 'user-message' : 'admin-message'}"><strong>${msg.sender.username}:</strong> ${msg.content}</li>`;
    }).join('');

    const content = `
        <style>
            #private-chat-messages { list-style: none; padding: 0; margin: 0; height: 60vh; overflow-y: auto; display: flex; flex-direction: column; }
            #private-chat-form { display: flex; margin-top: 10px; }
            #private-chat-input { flex-grow: 1; }
        </style>
        <h1>Chat com ${friend.username}</h1>
        <div class="card">
            <ul id="private-chat-messages">${messagesHtml}</ul>
            <form id="private-chat-form">
                <input id="private-chat-input" class="form-group" autocomplete="off" />
                <button class="btn" style="width: auto; margin-left: 10px;">Enviar</button>
            </form>
        </div>
    `;

    const pageScript = `
        const friendId = "${friendId}";
        const form = document.getElementById('private-chat-form');
        const input = document.getElementById('private-chat-input');
        const messages = document.getElementById('private-chat-messages');
        messages.scrollTop = messages.scrollHeight;

        socket.emit('join_private_chat', { friendId });

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            if (input.value) {
                socket.emit('private_message', { to: friendId, content: input.value });
                const li = document.createElement('li');
                li.className = 'user-message';
                li.innerHTML = '<strong>Você:</strong> ' + input.value;
                messages.appendChild(li);
                messages.scrollTop = messages.scrollHeight;
                input.value = '';
            }
        });

        socket.on('private_message', (data) => {
            const li = document.createElement('li');
            li.className = 'admin-message';
            li.innerHTML = '<strong>' + data.from.username + ':</strong> ' + data.content;
            messages.appendChild(li);
            messages.scrollTop = messages.scrollHeight;
        });
    `;

    res.send(renderDashboardPage(req.session, `Chat com ${friend.username}`, content, pageScript));
});

// --- PÁGINA DE LUTA MULTIPLAYER ---

app.get('/multiplayer-fight', isAuthenticated, (req, res) => {
    // A página de multiplayer será muito parecida com a de luta normal,
    // mas a lógica de encontrar o oponente e iniciar a batalha será diferente.
    const content = `
        <h1>Arena Multiplayer</h1>
        <div id="matchmaking-screen">
            <div class="card">
                <p>Prepare-se para enfrentar outro jogador em tempo real!</p>
                <p>Sua força será baseada nos seus personagens e espadas.</p>
            </div>
            <button id="find-match-btn" class="btn">Procurar Oponente</button>
            <p id="matchmaking-status" style="margin-top: 15px;"></p>
        </div>

        <!-- A tela de batalha será preenchida pelo Socket.IO quando a partida começar -->
        <div id="battle-screen" style="display: none;">
            <!-- Conteúdo da batalha (arena, logs, etc.) será injetado aqui -->
        </div>
        <div id="awakening-overlay"></div>
    `;

    const pageScript = `
        const findMatchBtn = document.getElementById('find-match-btn');
        const matchmakingStatus = document.getElementById('matchmaking-status');
        const battleScreen = document.getElementById('battle-screen');

        findMatchBtn.addEventListener('click', () => {
            socket.emit('find multiplayer match');
            findMatchBtn.disabled = true;
            matchmakingStatus.textContent = 'Procurando oponente...';
        });

        socket.on('matchmaking_update', (data) => {
            matchmakingStatus.textContent = data.message;
        });

        socket.on('match_found', (data) => {
            document.getElementById('matchmaking-screen').style.display = 'none';
            battleScreen.style.display = 'block';
            // Injeta o HTML da arena de batalha e inicializa os scripts
            battleScreen.innerHTML = data.battleHtml;
            // ✅ CORREÇÃO: Adiciona um pequeno delay para garantir que o DOM seja renderizado
            // antes de o script tentar acessar os elementos. Usar DOMContentLoaded é mais robusto.
            const scriptTag = document.createElement('script');
            scriptTag.innerHTML = data.battleScript;
            battleScreen.appendChild(scriptTag);
        });

        socket.on('opponent_disconnected', () => {
            showNotification('O oponente desconectou. Você venceu por W.O.!', 'success');
            setTimeout(() => window.location.href = '/dashboard', 3000);
        });
    `;

    res.send(renderDashboardPage(req.session, 'Luta Multiplayer', content, pageScript));
});







/**
 * Função para criar o personagem especial do Admin.
 */
async function createSupremeAdminCharacter(adminUser) {
    try {
        // Verifica se o personagem já existe para este admin
        const existingChar = await prisma.character.findFirst({
            where: { ownerId: adminUser.id, rarity: Rarity.SUPREME }
        });

        if (existingChar) {
            console.log('Personagem SUPREME já existe para este admin.');
            return; // Se já existe, apenas encerra a função.
        }

        const supremeCharacter = await prisma.character.create({
            data: {
                name: 'The Overlord',
                ability: 'Absolute Power',
                // ✅ CORREÇÃO: Usando o enum importado, não uma string.
                rarity: Rarity.SUPREME,
                rarityColor: '#FFD700', // Dourado
                buffDescription: 'Imune a todos os efeitos negativos. Causa dano letal.',
                attack: 999999,
                health: 9999999,
                ownerId: adminUser.id,
            },
        });
        console.log('Personagem SUPREME criado com sucesso:', supremeCharacter.name);
    } catch (error) {
        console.error("Erro ao criar personagem SUPREME:", error);
    }
}

// Exemplo de como a lógica de "status infinito" funcionaria em uma batalha
function calculateDamage(attacker, defender) {
    if (attacker.rarity === Rarity.SUPREME) {
      return Infinity; // Dano infinito, vitória instantânea
    }
    if (defender.rarity === Rarity.SUPREME) {
      return 0; // Vida infinita, não recebe dano
    }
    return attacker.attack; // Lógica de dano normal
}

// --- Rota de Status (Página Inicial) ---
app.get('/', (req, res) => {
    // Redireciona para o dashboard se estiver logado, caso contrário, para a página de login.
    if (req.session.user) {
        res.redirect('/dashboard');
    } else {
        res.redirect('/register'); // Mudei para redirecionar para o cadastro como página inicial
    }
});

// --- Armazena sockets por email para fácil acesso ---
const onlineUsers = new Map();
// --- Fila de matchmaking e estados de batalha multiplayer ---
const matchmakingQueue = [];
const multiplayerBattleStates = new Map();


// --- Lógica do Socket.IO para o Chat ---
io.on('connection', (socket) => {
    const user = socket.request.session.user;

    // Se por algum motivo não houver usuário na sessão, desconecta.
    if (!user) { return socket.disconnect(true); }

    // Associa o email do usuário ao seu socket e o coloca em uma "sala" com seu email (para notificações diretas)
    onlineUsers.set(user.email, socket.id);
    socket.join(user.id); // Usa o ID do usuário como nome da sala pessoal

    console.log(`[CONEXÃO] ${user.username} conectou com socket ID ${socket.id}.`);

    // Lida com desconexão durante matchmaking ou batalha
    socket.on('disconnecting', () => {
        const battleRoom = Array.from(socket.rooms).find(room => room.startsWith('mp-battle-'));
        if (battleRoom) {
            socket.to(battleRoom).emit('opponent_disconnected');
            multiplayerBattleStates.delete(battleRoom);
        }
        matchmakingQueue.filter(p => p.socketId !== socket.id);
    });
    
    socket.on('disconnect', () => {
        onlineUsers.delete(user.email);
        console.log(`[CONEXÃO] ${user.username} desconectou.`);
        // Avisa a todos que o usuário saiu.
        io.emit('chat message', { username: 'Sistema', msg: `${user.username} saiu do chat.` });
    });

    socket.on('chat message', async (msg) => {
        // Verifica se o usuário não foi banido no meio tempo
        const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
        if (dbUser?.isBanned) {
            socket.emit('banned', { reason: dbUser.banReason });
            socket.disconnect(true);
            return;
        }
        // Quando recebe uma mensagem, envia para todos os clientes conectados.
        io.emit('chat message', { username: user.username, msg: msg });
    });

    // --- Lógica do Socket.IO para o Chat de Tickets ---

    // Admin entra na sala de notificações globais de admin
    socket.on('join admin room', () => {
        if (user.isAdmin) socket.join('admin-room');
    });

    // Jogador entra na "sala" de um ticket específico
    socket.on('join ticket room', async (ticketId) => {
        const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
        // Validação: só pode entrar na sala se for o autor ou admin
        if (ticket && (ticket.authorId === user.id || user.isAdmin)) {
            socket.join(`ticket-${ticketId}`);
            console.log(`[TICKET] ${user.username} entrou na sala do ticket #${ticketId}`);
        }
    });

    // Recebe uma nova mensagem para um ticket
    socket.on('ticket message', async ({ ticketId, content }) => {
        const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
        // Validação: só pode enviar mensagem se for o autor ou admin
        if (ticket && (ticket.authorId === user.id || user.isAdmin)) {
            // Se um admin responde, o ticket é reaberto
            if (user.isAdmin && ticket.status === 'closed') {
                await prisma.ticket.update({ where: { id: ticketId }, data: { status: 'open' } });
            }

            const newMessage = await prisma.ticketMessage.create({
                data: {
                    content,
                    ticketId: ticketId,
                    authorName: user.username,
                    isAdmin: user.isAdmin
                }
            });

            // Envia a nova mensagem para todos na sala do ticket
            io.to(`ticket-${ticketId}`).emit('new ticket message', newMessage);
        }
    });

    // --- Lógica do Socket.IO para a Arena de Batalha ---
    let battleState = null;

    socket.on('start battle', async () => {
        const dbUser = await prisma.user.findUnique({ where: { id: user.id }, include: { characters: true, swords: true } });
        if (!dbUser) return;

        const { totalPower, totalHealth, activeCharacter } = calculatePlayerBuffs(dbUser, dbUser.characters, dbUser.swords);
        const opponentData = opponents[Math.floor(Math.random() * opponents.length)];

        battleState = {
            player: { id: dbUser.id, name: dbUser.username, health: totalHealth, maxHealth: totalHealth, power: totalPower, isDefending: false, activeCharacter: activeCharacter, abilityUsed: false, awakenedState: { active: false, character: null, turnsLeft: 0, abilityName: '' } },
            opponent: { ...opponentData, maxHealth: opponentData.health },
            log: [],
            turn: 'player'
        };

        io.to(socket.id).emit('battle update', {
            log: `Uma batalha começou! Você enfrenta ${battleState.opponent.name}.`,
            player: battleState.player,
            opponent: battleState.opponent,
            isPlayerTurn: true,
            canUseAbility: battleState.player.activeCharacter && !battleState.player.abilityUsed
        });
    });

    socket.on('battle action', async (action) => {
        if (!battleState || battleState.turn !== 'player') return;

        let playerDamage = 0;
        let logMessage = '';
        let abilityUsedName = null;

        // Lógica de crítico
        const isCritical = Math.random() < 0.1; // 10% de chance de crítico
        const critMultiplier = isCritical ? 1.5 : 1.0;

        // Turno do Jogador
        switch (action) {
            case 'fast_attack':
                playerDamage = Math.floor(battleState.player.power * 0.5 * (0.9 + Math.random() * 0.2) * critMultiplier);
                logMessage = `Você usa um Ataque Rápido e causa ${playerDamage} de dano!${isCritical ? ' (CRÍTICO!)' : ''}`;
                break;
            case 'strong_attack':
                if (Math.random() > 0.3) { // 70% de chance de acertar
                    playerDamage = Math.floor(battleState.player.power * 1.0 * (0.8 + Math.random() * 0.4) * critMultiplier);
                    logMessage = `Você usa um Ataque Forte e causa ${playerDamage} de dano!${isCritical ? ' (CRÍTICO!)' : ''}`;
                } else {
                    logMessage = 'Você usa um Ataque Forte, mas erra!';
                }
                break;
            case 'defend':
                battleState.player.isDefending = true;
                logMessage = 'Você assume uma postura defensiva.';
                break;
            case 'use_ability':
                if (battleState.player.activeCharacter && !battleState.player.abilityUsed) {
                    const charName = battleState.player.activeCharacter.name;
                    abilityUsedName = charName; // Para o efeito visual
                    logMessage = `Você desperta o poder de ${charName}!`;
                    battleState.player.abilityUsed = true;
                    battleState.player.awakenedState.active = true;
                    battleState.player.awakenedState.character = charName;
                    battleState.player.awakenedState.turnsLeft = 3; // Duração do Despertar
                    
                    if (charName === 'Jacket') battleState.player.awakenedState.abilityName = 'Combo Violento';
                    if (charName === 'The Overlord') battleState.player.awakenedState.abilityName = 'Aniquilação';
                    if (charName === 'RATO MAROMBA') battleState.player.awakenedState.abilityName = 'FIBRA ABSOLUTA';
                    
                    // 1. Envia o comando para a cutscene
                    io.to(socket.id).emit('play awakening', { character: charName });

                    // 2. Espera a cutscene terminar e devolve o turno ao jogador no estado Despertado
                    setTimeout(() => {
                        io.to(socket.id).emit('battle update', { 
                            log: `O poder de ${charName} flui através de você!`, 
                            player: battleState.player, opponent: battleState.opponent, 
                            isPlayerTurn: true,
                            canUseAbility: false // Já usou o Despertar
                        });
                    }, 4500); // Delay para a cutscene (4.5 segundos)
                    return; // Interrompe a execução normal para aguardar a cutscene

                } else {
                    logMessage = 'Você não pode usar a habilidade agora.';
                }
                break;
            case 'awakened_ability':
                if (battleState.player.awakenedState.active) {
                    const charName = battleState.player.awakenedState.character;
                    abilityUsedName = charName;
                    logMessage = `Você usa ${battleState.player.awakenedState.abilityName}!`;

                    if (charName === 'Jacket') playerDamage = 300;
                    if (charName === 'The Overlord') playerDamage = Infinity;
                    if (charName === 'RATO MAROMBA') playerDamage = 10000;

                    battleState.player.awakenedState.turnsLeft--;
                } else {
                    logMessage = 'Você não pode usar a habilidade agora.';
                }
                break;
        }
        battleState.opponent.health = Math.max(0, battleState.opponent.health - playerDamage);
        io.to(socket.id).emit('battle update', { 
            log: logMessage, player: battleState.player, opponent: battleState.opponent, 
            isPlayerTurn: false, damageToOpponent: playerDamage, abilityUsed: abilityUsedName
        });

        // Se não foi uma habilidade com delay, continua a batalha normalmente
        if (action !== 'use_ability') {
            checkBattleEndAndContinue(socket, battleState, user);
        }
    });

    // --- LÓGICA DE BATALHA MULTIPLAYER ---
    socket.on('find multiplayer match', async () => {
        const user = socket.request.session.user;
        const dbUser = await prisma.user.findUnique({
            where: { id: user.id },
            include: { characters: true, swords: true }
        });

        const { totalPower, totalHealth, activeCharacter } = calculatePlayerBuffs(dbUser, dbUser.characters, dbUser.swords);

        const playerData = {
            socketId: socket.id,
            user: { ...user, profilePictureUrl: dbUser.profilePictureUrl },
            stats: {
                id: dbUser.id,
                name: dbUser.username,
                health: totalHealth,
                maxHealth: totalHealth,
                power: totalPower,
                isDefending: false,
                activeCharacter: activeCharacter,
                abilityUsed: false,
                awakenedState: { active: false, character: null, turnsLeft: 0, abilityName: '' }
            }
        };

        // Adiciona o jogador à fila
        matchmakingQueue.push(playerData);
        socket.emit('matchmaking_update', { message: 'Na fila... aguardando oponente.' });

        // Se houver 2 ou mais jogadores, inicia a partida
        if (matchmakingQueue.length >= 2) {
            const player1 = matchmakingQueue.shift();
            const player2 = matchmakingQueue.shift();

            const battleRoomId = `mp-battle-${player1.user.id}-${player2.user.id}`;
            
            const p1Socket = io.sockets.sockets.get(player1.socketId);
            const p2Socket = io.sockets.sockets.get(player2.socketId);

            if (!p1Socket || !p2Socket) {
                // Se um dos jogadores desconectou, coloca o outro de volta na fila
                if(p1Socket) matchmakingQueue.unshift(player1);
                if(p2Socket) matchmakingQueue.unshift(player2);
                return;
            }

            p1Socket.join(battleRoomId);
            p2Socket.join(battleRoomId);

            const battleState = {
                player1: player1.stats,
                player2: player2.stats,
                turn: 'player1',
                roomId: battleRoomId
            };
            multiplayerBattleStates.set(battleRoomId, battleState);

            // Envia a UI e o script da batalha para ambos os jogadores
            const battleHtml = getMultiplayerBattleHtml(player1, player2);
            const battleScript = getFullBattleScript('multiplayer battle action');

            io.to(player1.socketId).emit('match_found', { battleHtml, battleScript });
            io.to(player2.socketId).emit('match_found', { battleHtml: getMultiplayerBattleHtml(player2, player1), battleScript });

            // Envia a primeira atualização de estado
            setTimeout(() => {
                io.to(player1.socketId).emit('battle update', { log: 'A batalha começa! É o seu turno.', player: battleState.player1, opponent: battleState.player2, isPlayerTurn: true, canUseAbility: player1.stats.activeCharacter && !player1.stats.abilityUsed });
                io.to(player2.socketId).emit('battle update', { log: `A batalha começa! Turno de ${player1.user.username}.`, player: battleState.player2, opponent: battleState.player1, isPlayerTurn: false });
            }, 500);
        }
    });

    socket.on('multiplayer battle action', (action) => {
        const user = socket.request.session.user;
        const battleRoom = Array.from(socket.rooms).find(room => room.startsWith('mp-battle-'));
        if (!battleRoom) return;

        const battleState = multiplayerBattleStates.get(battleRoom);
        if (!battleState) return;

        const isPlayer1 = battleState.player1.id === user.id;
        const currentPlayerKey = isPlayer1 ? 'player1' : 'player2';
        const opponentPlayerKey = isPlayer1 ? 'player2' : 'player1';

        if (battleState.turn !== currentPlayerKey) return; // Não é o turno do jogador

        let playerDamage = 0;
        let logMessage = '';
        let abilityUsedName = null;

        const currentPlayer = battleState[currentPlayerKey];
        const opponentPlayer = battleState[opponentPlayerKey];

        // Lógica de Ação (similar à de PvE)
        switch (action) {
            case 'fast_attack':
                playerDamage = Math.floor(currentPlayer.power * 0.5 * (0.9 + Math.random() * 0.2));
                logMessage = `${currentPlayer.name} usa um Ataque Rápido e causa ${playerDamage} de dano!`;
                break;
            case 'strong_attack':
                 if (Math.random() > 0.3) {
                    playerDamage = Math.floor(currentPlayer.power * 1.0 * (0.8 + Math.random() * 0.4));
                    logMessage = `${currentPlayer.name} usa um Ataque Forte e causa ${playerDamage} de dano!`;
                } else {
                    logMessage = `${currentPlayer.name} usa um Ataque Forte, mas erra!`;
                }
                break;
            // Adicionar outros casos (strong_attack, defend)
            case 'use_ability':
                if (currentPlayer.activeCharacter && !currentPlayer.abilityUsed) {
                    const charName = currentPlayer.activeCharacter.name;
                    logMessage = `${currentPlayer.name} desperta o poder de ${charName}!`;
                    currentPlayer.abilityUsed = true;
                    currentPlayer.awakenedState = { active: true, character: charName, turnsLeft: 3, abilityName: charName === 'Jacket' ? 'Combo Violento' : 'Aniquilação' };

                    // Envia cutscene para o jogador atual
                    io.to(socket.id).emit('play awakening', { character: charName });

                    // ✅ Envia cutscene customizada para o oponente
                    let opponentMessages = [];
                    let theme = '';
                    if (charName === 'Jacket') {
                        opponentMessages = ["Do you know...", "what time it is?", "...It's time to hurt other people."];
                        theme = '/audio/jacket-theme.mp3';
                    } else if (charName === 'The Overlord') {
                        opponentMessages = ["Você enfrentou o dono do site...", "Corajoso, ein?"];
                        theme = '/audio/overlord-theme.mp3';
                    } else if (charName === 'RATO MAROMBA') {
                        opponentMessages = ["EAE, MERMÃO...", "MEXEU COM O RATO ERRADO...", "VOU TE ESMAGAR!"];
                        theme = '/audio/rato-maromba-theme.mp3';
                    }
                    
                    const opponentSocket = Array.from(io.sockets.adapter.rooms.get(battleRoom)).find(sId => sId !== socket.id);
                    if (opponentSocket) {
                        io.to(opponentSocket).emit('play opponent awakening', { character: charName, messages: opponentMessages, theme });
                    }

                    setTimeout(() => {
                        io.to(socket.id).emit('battle update', { log: `O poder de ${charName} flui através de você!`, player: currentPlayer, opponent: opponentPlayer, isPlayerTurn: true, canUseAbility: false });
                        if (opponentSocket) {
                            io.to(opponentSocket).emit('battle update', { log: `${currentPlayer.name} despertou um poder terrível!`, player: opponentPlayer, opponent: currentPlayer, isPlayerTurn: false });
                        }
                    }, 4500);
                    return;
                }
                break;
            case 'awakened_ability':
                 if (currentPlayer.awakenedState.active) {
                    const charName = currentPlayer.awakenedState.character;
                    abilityUsedName = charName;
                    logMessage = `${currentPlayer.name} usa ${currentPlayer.awakenedState.abilityName}!`;

                    if (charName === 'Jacket') playerDamage = 300;
                    if (charName === 'The Overlord') playerDamage = Infinity;
                    if (charName === 'RATO MAROMBA') playerDamage = 10000;

                    currentPlayer.awakenedState.turnsLeft--;
                }
                break;
        }

        opponentPlayer.health = Math.max(0, opponentPlayer.health - playerDamage);
        battleState.turn = opponentPlayerKey; // Passa o turno

        // A lógica de passar o turno e checar o fim do jogo é encapsulada
        // para evitar repetição e garantir que o estado seja atualizado corretamente.
        const continueMultiplayerBattle = async () => {
            // Atualiza ambos os jogadores
            const opponentSocketId = Array.from(io.sockets.adapter.rooms.get(battleRoom)).find(sId => sId !== socket.id);

            // Update para o jogador que atacou
            io.to(socket.id).emit('battle update', { log: logMessage, player: currentPlayer, opponent: opponentPlayer, isPlayerTurn: false, damageToOpponent: playerDamage, abilityUsed: abilityUsedName });
            // Update para o oponente
            if (opponentSocketId) {
                io.to(opponentSocketId).emit('battle update', { log: logMessage, player: opponentPlayer, opponent: currentPlayer, isPlayerTurn: true, damageToPlayer: playerDamage, canUseAbility: opponentPlayer.activeCharacter && !opponentPlayer.abilityUsed });
            }

            // Checar fim de jogo
            if (opponentPlayer.health <= 0) {
            // Ganha XP no PvP
            await gainXP(currentPlayer.id, 75);
            showNotificationForSocket(socket.id, '+75 XP!', 'success');

                io.to(socket.id).emit('battle end', { win: true, message: 'VITÓRIA!' });
                if (opponentSocketId) io.to(opponentSocketId).emit('battle end', { win: false, message: 'DERROTA!' });
                multiplayerBattleStates.delete(battleRoom);
            }
        };

    // Função para notificar um socket específico
    async function showNotificationForSocket(socketId, message, type) {
        io.to(socketId).emit('show_notification', { message, type });
    }



        continueMultiplayerBattle();
    });

    // --- Lógica do Socket.IO para Chat de Amigos ---
    socket.on('join_private_chat', ({ friendId }) => {
        const roomName = [user.id, friendId].sort().join('-');
        socket.join(roomName);
        console.log(`[CHAT PRIVADO] ${user.username} entrou na sala ${roomName}`);
    });

    socket.on('private_message', async ({ to, content }) => {
        const roomName = [user.id, to].sort().join('-');
        
        // Salva a mensagem no banco de dados
        await prisma.privateMessage.create({
            data: {
                content,
                senderId: user.id,
                receiverId: to
            }
        });

        // Envia a mensagem para o outro usuário na sala
        socket.to(roomName).emit('private_message', {
            content,
            from: { id: user.id, username: user.username }
        });
    });
});

async function checkBattleEndAndContinue(socket, battleState, user) {
    if (battleState.opponent.health <= 0) {
        await prisma.user.update({ where: { id: user.id }, data: { coins: { increment: 50 } }});
        await gainXP(user.id, 50); // Ganha 50 XP por vitória
        return io.to(socket.id).emit('battle end', { win: true, message: 'VITÓRIA!' });
    }

    // Turno do Oponente (após um delay)
    setTimeout(async () => {
        let opponentLog = '';
        // Verifica se o Despertar acabou no início do turno do oponente
        if (battleState.player.awakenedState.active && battleState.player.awakenedState.turnsLeft <= 0) {
            battleState.player.awakenedState.active = false;
            // ✅ CORREÇÃO: Emite o evento para parar a música e o RGB no cliente.
            io.to(socket.id).emit('awakening end');
            // ✅ CORREÇÃO: A mensagem de que o despertar acabou agora é enviada junto com o ataque do oponente,
            // garantindo que o estado do jogador (player.awakenedState.active = false) seja atualizado corretamente no cliente.
            // Isso evita que os botões e efeitos persistam.
            opponentLog = 'O poder do Despertar se esvai... ';
        }
        try {
            const opponentCrit = Math.random() < 0.05; // Oponente tem 5% de chance de crítico
            const opponentCritMultiplier = opponentCrit ? 1.5 : 1.0;
            let opponentDamage = Math.floor(battleState.opponent.power * 0.8 * (0.8 + Math.random() * 0.4) * opponentCritMultiplier);
            opponentLog += `${battleState.opponent.name} ataca!`;

            if (battleState.player.isDefending) { opponentDamage = Math.floor(opponentDamage * 0.3); // Defesa reduz 70% do dano
                opponentLog += ` Você defende e reduz o dano para ${opponentDamage}!${opponentCrit ? ' (CRÍTICO!)' : ''}`;
                battleState.player.isDefending = false;
            } else {
                opponentLog += ` Ele causa ${opponentDamage} de dano!${opponentCrit ? ' (CRÍTICO!)' : ''}`;
            }

            battleState.player.health = Math.max(0, battleState.player.health - opponentDamage);
            io.to(socket.id).emit('battle update', { 
                log: opponentLog,
                player: battleState.player, opponent: battleState.opponent, 
                isPlayerTurn: true, damageToPlayer: opponentDamage,
                canUseAbility: battleState.player.activeCharacter && !battleState.player.abilityUsed
            });

            if (battleState.player.health <= 0) {
                const coinLoss = 25;
                const dbUser = await prisma.user.findUnique({ where: { id: user.id }, select: { coins: true } });
                const newCoins = Math.max(0, dbUser.coins - coinLoss);
                await prisma.user.update({ where: { id: user.id }, data: { coins: newCoins } });
                return io.to(socket.id).emit('battle end', { win: false, message: 'DERROTA!' });
            }

            battleState.turn = 'player';
        } catch (error) {
            console.error("Erro no turno do oponente:", error);
        }
    }, 1500);
    battleState.turn = 'opponent';
}

// --- FUNÇÕES DO SISTEMA DE NÍVEL ---

async function gainXP(userId, amount) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return;

    let newXP = user.xp + amount;
    let newLevel = user.level;
    let newStatPoints = user.statPoints;
    let xpToNext = user.xpToNextLevel;

    while (newXP >= xpToNext) {
        newXP -= xpToNext;
        newLevel++;
        newStatPoints += 5; // Ganha 5 pontos por nível
        xpToNext = Math.floor(100 * Math.pow(newLevel, 1.5));
        // Notifica o jogador sobre o level up
        io.to(userId).emit('show_notification', { message: `Você subiu para o nível ${newLevel}!`, type: 'success' });
    }

    await prisma.user.update({
        where: { id: userId },
        data: { xp: newXP, level: newLevel, statPoints: newStatPoints, xpToNextLevel: xpToNext }
    });
}

// --- Inicia o servidor ---
server.listen(port, async () => { // Mudamos de app.listen para server.listen
    // Cria a conta de admin na inicialização, se não existir
    const adminUser = process.env.ADMIN_USERNAME;
    const adminEmail = `${adminUser}@admin.local`;

    if (adminUser && process.env.ADMIN_PASSWORD) {
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, salt);
        const adminUserRecord = await prisma.user.upsert({
            where: { email: adminEmail },
            update: { passwordHash, isAdmin: true },
            create: { email: adminEmail, username: adminUser, passwordHash, isAdmin: true, coins: 999999 },
        });
        console.log(`[SISTEMA] Conta de administrador '${adminUser}' criada/carregada.`);
        
        // Cria o personagem SUPREME para o admin, se não existir
        await createSupremeAdminCharacter(adminUserRecord);
    }

    console.log(`Servidor rodando na porta ${port}`);
    console.log(`Acesse http://localhost:${port}`);
});

// Funções auxiliares para o modo multiplayer

function getMultiplayerBattleHtml(player, opponent) {
    const playerPic = player.user.profilePictureUrl || 'https://via.placeholder.com/128?text=?';
    const opponentPic = opponent.user.profilePictureUrl || 'https://via.placeholder.com/128?text=?';

    return `
        <div class="battle-arena">
            <!-- Jogador -->
            <div class="fighter" id="player-fighter">
                <img src="${playerPic}" class="fighter-sprite" style="object-fit: cover;">
                <h2 class="fighter-name">${player.user.username}</h2>
                <div class="health-bar-container">
                    <div id="player-health-bar" class="health-bar" style="width: 100%;"></div>
                </div>
                <div id="player-health-text" class="health-text">${player.stats.maxHealth} / ${player.stats.maxHealth}</div>
            </div>

            <!-- Oponente -->
            <div class="fighter" id="opponent-fighter">
                <img src="${opponentPic}" class="fighter-sprite" style="object-fit: cover;">
                <h2 id="opponent-name" class="fighter-name">${opponent.user.username}</h2>
                <div class="health-bar-container">
                    <div id="opponent-health-bar" class="health-bar" style="width: 100%;"></div>
                </div>
                <div id="opponent-health-text" class="health-text">${opponent.stats.maxHealth} / ${opponent.stats.maxHealth}</div>
            </div>
        </div>

        <div id="battle-actions" class="card" style="text-align: center; display: none;">
             <h3>Seu Turno!</h3>
             <button class="btn" onclick="sendAction('fast_attack')">Ataque Rápido</button>
             <button class="btn" onclick="sendAction('strong_attack')">Ataque Forte</button>
             <button class="btn" onclick="sendAction('defend')">Defender</button>
             <button id="ability-btn" class="btn btn-special" onclick="sendAction('use_ability')" style="display: none;">Despertar</button>
        </div>

         <div id="battle-log" class="card" style="margin-top: 20px; max-height: 200px; overflow-y: auto;">
             <h4>Log de Combate</h4>
             <ul id="log-list" style="list-style: none; padding: 0; font-size: 0.9em;"></ul>
         </div>
    `;
}
