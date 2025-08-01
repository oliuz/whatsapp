var axios = require('axios');
require('dotenv').config()
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia  } = require('whatsapp-web.js');
const { config } = require('dotenv');
const logger = require('./logger');
const fs = require('fs');
const { execSync } = require('child_process');

const whatsapp = new Client({
  puppeteer: {
    // Solo usar executablePath específico en Linux/producción
    ...(process.platform === 'linux' && {
      executablePath: '/root/.cache/puppeteer/chrome/linux-137.0.7151.119/chrome-linux64/chrome'
    }),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  },
  authStrategy: new LocalAuth({
    clientId: "cliente-2"
  }),
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
  }
});

const whatsappState = { isReady: false };

// Variable para trackear última operación exitosa
let lastSuccessfulOperation = Date.now();

// Función para actualizar timestamp de última operación
function updateLastOperation() {
    lastSuccessfulOperation = Date.now();
}

// Función para verificar si el cliente está realmente listo
async function isClientReady() {
    if (!whatsappState.isReady) {
        return false;
    }
    
    try {
        // Intentar una operación simple para verificar que la sesión está activa
        const state = await whatsapp.getState();
        updateLastOperation();
        return state === 'CONNECTED';
    } catch (error) {
        logger.warn(`Client state check failed: ${error.message}`);
        whatsappState.isReady = false;
        return false;
    }
}

// Función para envío de mensajes con timeout
async function sendMessageWithTimeout(chatId, message, options = {}, timeoutMs = 30000) {
    return Promise.race([
        whatsapp.sendMessage(chatId, message, options),
        new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Send message timeout')), timeoutMs)
        )
    ]);
}

// Función para manejar errores de sesión cerrada
function handleSessionError(error) {
    const isSessionClosed = error.message && (
        error.message.includes('Session closed') ||
        error.message.includes('Protocol error') ||
        error.message.includes('Target closed')
    );
    
    if (isSessionClosed) {
        logger.warn('Session closed detected, marking client as not ready');
        whatsappState.isReady = false;
        return true;
    }
    
    // Manejar error de SingletonLock
    if (error.message && error.message.includes('SingletonLock')) {
        logger.warn('Intentando resolver bloqueo por SingletonLock...');

        try {
            execSync('pkill -f puppeteer');
            execSync('pkill -f chrome');
            fs.unlinkSync('/root/app/soporte/.wwebjs_auth/session-cliente-2/SingletonLock');
            logger.info('Bloqueo eliminado, intentando re-iniciar...');
            // Marcar como no listo para que el intervalo lo reinicie
            whatsappState.isReady = false;
        } catch (e) {
            logger.error('Error al intentar limpiar el lock:', e);
        }
        return true;
    }
    
    return false;
}

// Health check más robusto
async function performHealthCheck() {
    try {
        if (!whatsappState.isReady) return false;
        
        // Test múltiples operaciones
        const state = await whatsapp.getState();
        await whatsapp.getContacts(); // Operación que requiere sesión activa
        
        updateLastOperation(); // Actualizar timestamp de última operación exitosa
        return state === 'CONNECTED';
    } catch (error) {
        logger.error(`Health check failed: ${error.message}`);
        handleSessionError(error);
        return false;
    }
}

whatsapp.on('qr', qr => {
    logger.info('QR code generated for WhatsApp session');
    qrcode.generate(qr, { small: true });
    logger.info(qr);
});

whatsapp.on('ready', () => {
    logger.info('WhatsApp client is ready!');
    whatsappState.isReady = true;
    updateLastOperation();
});

async function notifyDown(reason) {
    if (process.env.ONDOWN) {
        const data = {
            message: 'WhatsApp client is down',
            reason: reason || 'unknown',
            timestamp: new Date().toISOString()
        };
        try {
            await axios.post(process.env.ONDOWN, data, {
                headers: { 'Content-Type': 'application/json' }
            });
            logger.info(`Posted ONDOWN info to ${process.env.ONDOWN}`);
        } catch (err) {
            logger.error(`Error posting ONDOWN info: ${err.stack || err}`);
        }
    }
}

whatsapp.on('disconnected', (reason) => {
    logger.warn(`WhatsApp client disconnected: ${reason}`);
    whatsappState.isReady = false;
    notifyDown(reason);
});

whatsapp.on('auth_failure', (msg) => {
    logger.error(`Authentication failure: ${msg}`);
    whatsappState.isReady = false;
    notifyDown(msg);
});

whatsapp.on('call', async (call) => {
    logger.info(`Incoming call from ${call.from} (${call.isVideo ? 'video' : 'voice'})`);
    
    try {
        // Rechaza la llamada
        await call.reject();
        logger.info(`Call from ${call.from} rejected.`);

        // Envía mensaje al usuario que llamó
        await whatsapp.sendMessage(call.from, 'No se pueden recibir llamadas');
        logger.info(`Sent "No se pueden recibir llamadas" to ${call.from}`);
        updateLastOperation();
    } catch (err) {
        logger.error(`Error handling call: ${err.stack || err}`);
        handleSessionError(err);
        return; // No continuar si hay error de sesión
    }

    // (Opcional) Notifica a ONMESSAGE si está configurado
    if (process.env.ONMESSAGE) {
        const data = {
            phoneNumber: `${call.from}`,
            message: `Llamada rechazada del número: ${call.from}`,
            type: 'call',
            isVideo: call.isVideo,
            timestamp: new Date().toISOString()
        };
        try {
            await axios.post(process.env.ONMESSAGE, data, {
                headers: { 'Content-Type': 'application/json' }
            });
            logger.info(`Posted call info to ${process.env.ONMESSAGE}`);
        } catch (err) {
            logger.error(`Error posting call info: ${err.stack || err}`);
        }
    }
});

whatsapp.on( 'message', async (msg) => {
    logger.info(`Received message from ${msg.from} of type ${msg.type}`);

    // Filtrar mensajes de estado (status@broadcast y similares)
    if (msg.from === 'status@broadcast' || msg.from === 'status@c.us') {
        logger.info(`Estado ignorado de ${msg.from} | type: ${msg.type} | id: ${msg.id ? msg.id._serialized : 'N/A'}`);
        return;
    }

    // Tipos a ignorar
    const ignoredTypes = [
        'sticker', 'call_log', 'e2e_notification', 'revoked', 'multi_vcard',
        'order', 'product', 'list', 'buttons_response', 'list_response',
        'poll', 'poll_response'
    ];

    if (ignoredTypes.includes(msg.type)) {
        logger.info(`Mensaje ignorado de tipo ${msg.type} de ${msg.from}`);
        return;
    }

    if (process.env.ONMESSAGE) {
        let match = msg.from.match(/^([^@]+)@/);
        let phoneNumber = match ? match[1] : null;
        let url = process.env.ONMESSAGE;
        let data = {
            phoneNumber: `${phoneNumber}`,
            type: msg.type,
            from: msg.from,
            id: msg.id ? msg.id._serialized : undefined,
            timestamp: msg.timestamp,
            body: msg.body || '',
            hasMedia: msg.hasMedia || false
        };

        switch (msg.type) {
            case 'chat':
                // Solo texto
                break;
            case 'image':
                data.imagen = true;
                data.caption = msg.caption || '';
                break;
            case 'video':
                data.video = true;
                data.caption = msg.caption || '';
                break;
            case 'audio':
            case 'ptt':
                data.audio = true;
                break;
            case 'document':
                data.document = true;
                data.filename = msg.filename || '';
                data.caption = msg.caption || '';
                break;
            case 'location':
                data.location = {
                    latitude: msg.location?.latitude,
                    longitude: msg.location?.longitude,
                    description: msg.location?.description
                };
                break;
            case 'contact':
            case 'vcard':
                data.contact = msg.vcard || '';
                break;
            case 'ciphertext':
                data.ciphertext = true;
                break;
            default:
                // Si llega aquí, es un tipo permitido pero no detallado
                break;
        }

        logger.info(`Posting message to ONMESSAGE (${url}): ${JSON.stringify(data)}`);

        let config = {
            headers: {
                'Content-type': 'application/json'
            }
        };
        try {
            await axios.post(url, JSON.stringify(data), config);
            logger.info(`Posted message info to ${url} | id: ${data.id} | type: ${data.type} | phoneNumber: ${data.phoneNumber}`);
            updateLastOperation();
        } catch (err) {
            logger.error(`Error posting message info: ${err.stack || err} | id: ${data.id} | type: ${data.type} | phoneNumber: ${data.phoneNumber}`);
            
            // Si hay error de sesión cerrada durante el procesamiento de mensajes
            handleSessionError(err);
        }
    }
});

// Health check cada 30 segundos
setInterval(async () => {
    const isHealthy = await performHealthCheck();
    if (!isHealthy && whatsappState.isReady) {
        logger.warn('Health check failed, marking client as not ready');
        whatsappState.isReady = false;
    }
}, 30 * 1000);

// Monitor de cliente zombie cada 5 minutos
setInterval(async () => {
    const timeSinceLastOperation = Date.now() - lastSuccessfulOperation;
    const maxIdleTime = 15 * 60 * 1000; // 15 minutos
    
    if (timeSinceLastOperation > maxIdleTime && whatsappState.isReady) {
        logger.warn(`Client may be zombie (${timeSinceLastOperation/1000}s idle), forcing restart`);
        try {
            await whatsapp.destroy();
        } catch (e) {
            logger.error('Error destroying zombie client:', e);
        }
        whatsappState.isReady = false;
        setTimeout(() => whatsapp.initialize(), 5000);
    }
}, 5 * 60 * 1000);

// Garbage collection cada 30 minutos
setInterval(() => {
    if (global.gc) {
        global.gc();
        logger.info('Garbage collection executed');
    }
}, 30 * 60 * 1000);

// Cleanup al cerrar proceso
process.on('beforeExit', async () => {
    logger.info('Process before exit, cleaning up...');
    try {
        await whatsapp.destroy();
        // Forzar limpieza de procesos Chrome/Puppeteer
        execSync('pkill -f chrome || true', { stdio: 'ignore' });
        execSync('pkill -f puppeteer || true', { stdio: 'ignore' });
    } catch (e) {
        logger.error('Error in cleanup:', e);
    }
});

module.exports = { whatsapp, MessageMedia, whatsappState, isClientReady, handleSessionError, sendMessageWithTimeout, updateLastOperation };




