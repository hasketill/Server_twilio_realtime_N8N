// Serveur WebSocket avec intégration Twilio pour API en temps réel
const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const twilio = require('twilio');
const bodyParser = require('body-parser');

// Charger les variables d'environnement depuis .env
dotenv.config();

// Configuration
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const app = express();

// Initialiser les clients
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN 
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

// Middleware pour parser le JSON et les données de formulaire
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: false }));

// Création d'un serveur HTTP
const server = http.createServer(app);

// Création du serveur WebSocket
const wss = new WebSocket.Server({ server });

// Route de base pour tester que le serveur est en marche
app.get('/', (req, res) => {
  console.log('Requête HTTP reçue sur la route racine');
  res.send('Serveur WebSocket avec intégration Twilio pour API en temps réel est actif');
});

// Stockage des clients connectés et des sessions d'appel
const clients = new Map();
const callSessions = new Map();

// ====== ROUTES TWILIO ======

// Route pour initier un appel Twilio via API REST
app.post('/api/calls/initiate', async (req, res) => {
  console.log('Requête d\'initiation d\'appel reçue:', req.body);
  
  try {
    const { to, campaignId, agentId, script } = req.body;
    
    if (!to) {
      return res.status(400).json({ error: 'Numéro de téléphone requis' });
    }
    
    if (!twilioClient) {
      return res.status(500).json({ error: 'Twilio non configuré sur le serveur' });
    }
    
    // Créer une session d'appel
    const sessionId = generateUniqueId();
    
    // Stocker les informations de session
    callSessions.set(sessionId, {
      to,
      campaignId,
      agentId,
      script,
      status: 'initiating',
      startTime: new Date(),
      events: []
    });
    
    // Informer les clients WebSocket
    broadcastMessage({
      type: 'call_initiating',
      sessionId,
      to,
      campaignId,
      agentId,
      script,
      timestamp: new Date().toISOString()
    });
    
    // Récupérer l'URL base du serveur
    const baseUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
    
    // Initier l'appel via Twilio
    const call = await twilioClient.calls.create({
      url: `${baseUrl}/api/twilio/twiml?sessionId=${sessionId}`,
      to: to,
      from: TWILIO_PHONE_NUMBER,
      statusCallback: `${baseUrl}/api/twilio/status-callback?sessionId=${sessionId}`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST'
    });
    
    // Mettre à jour la session avec l'ID d'appel Twilio
    const session = callSessions.get(sessionId);
    session.twilioCallSid = call.sid;
    session.status = 'initiated';
    session.events.push({
      type: 'call_initiated',
      twilioCallSid: call.sid,
      timestamp: new Date().toISOString()
    });
    callSessions.set(sessionId, session);
    
    // Informer les clients WebSocket
    broadcastMessage({
      type: 'call_initiated',
      sessionId,
      twilioCallSid: call.sid,
      timestamp: new Date().toISOString()
    });
    
    // Répondre à la requête API
    res.status(200).json({
      success: true,
      sessionId,
      twilioCallSid: call.sid
    });
    
  } catch (error) {
    console.error('Erreur lors de l\'initiation de l\'appel:', error);
    res.status(500).json({
      error: 'Échec de l\'initiation de l\'appel',
      message: error.message
    });
  }
});

// Route pour fournir le TwiML pour les appels sortants
app.post('/api/twilio/twiml', (req, res) => {
  console.log('Requête TwiML reçue:', req.body);
  const sessionId = req.query.sessionId;
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  
  // Récupérer la session d'appel
  const session = callSessions.get(sessionId);
  
  // Informer les clients WebSocket du statut de l'appel
  broadcastMessage({
    type: 'call_status_update',
    sessionId,
    callSid,
    status: callStatus,
    timestamp: new Date().toISOString()
  });
  
  // Créer une réponse TwiML adaptée
  const twiml = new twilio.twiml.VoiceResponse();
  
  // Vérifier si la session existe
  if (!session) {
    twiml.say({
      voice: 'Polly.Céline',
      language: 'fr-FR'
    }, 'Désolé, une erreur est survenue. Cet appel n\'est pas valide.');
    twiml.hangup();
  } else {
    // Mettre à jour le statut de la session
    session.status = callStatus;
    session.events.push({
      type: 'call_status_update',
      status: callStatus,
      timestamp: new Date().toISOString()
    });
    callSessions.set(sessionId, session);
    
    // Si l'appel est en cours, délivrer le script
    if (callStatus === 'in-progress') {
      // Message d'accueil basé sur le script de la session
      const scriptText = session.script || 'Bonjour, ceci est un appel de prospection.';
      
      twiml.say({
        voice: 'Polly.Céline',
        language: 'fr-FR'
      }, scriptText);
      
      // Pause pour laisser le temps au prospect de comprendre
      twiml.pause({ length: 1 });
      
      // Collecter l'input utilisateur
      const gather = twiml.gather({
        input: 'dtmf speech',
        timeout: 5,
        numDigits: 1,
        action: `/api/twilio/gather?sessionId=${sessionId}`,
        method: 'POST'
      });
      
      gather.say({
        voice: 'Polly.Céline',
        language: 'fr-FR'
      }, 'Pour en savoir plus, appuyez sur 1. Pour ne plus être contacté, appuyez sur 2.');
      
      // Si pas de réponse, rediriger
      twiml.redirect(`/api/twilio/no-input?sessionId=${sessionId}`);
    } else {
      // Pour les autres statuts, terminer l'appel
      twiml.hangup();
    }
  }
  
  // Envoyer la réponse TwiML
  res.type('text/xml');
  res.send(twiml.toString());
});

// Route pour gérer les réponses de l'utilisateur
app.post('/api/twilio/gather', (req, res) => {
  console.log('Réponse utilisateur reçue:', req.body);
  
  const sessionId = req.query.sessionId;
  const digits = req.body.Digits || '';
  const speechResult = req.body.SpeechResult || '';
  const callSid = req.body.CallSid;
  
  // Récupérer la session
  const session = callSessions.get(sessionId);
  
  // Créer une réponse TwiML
  const twiml = new twilio.twiml.VoiceResponse();
  
  if (!session) {
    twiml.say({
      voice: 'Polly.Céline',
      language: 'fr-FR'
    }, 'Désolé, une erreur est survenue. Cet appel n\'est pas valide.');
    twiml.hangup();
  } else {
    // Enregistrer l'interaction
    session.events.push({
      type: 'user_input',
      digits,
      speechResult,
      timestamp: new Date().toISOString()
    });
    
    // Informer les clients WebSocket
    broadcastMessage({
      type: 'call_user_input',
      sessionId,
      callSid,
      digits,
      speechResult,
      timestamp: new Date().toISOString()
    });
    
    // Réponse basée sur l'entrée utilisateur
    if (digits === '1' || speechResult.toLowerCase().includes('plus')) {
      twiml.say({
        voice: 'Polly.Céline',
        language: 'fr-FR'
      }, 'Merci de votre intérêt. Un de nos conseillers vous contactera prochainement pour vous donner plus d\'informations.');
      
      // Marquer le prospect comme intéressé
      session.leadStatus = 'interested';
      session.events.push({
        type: 'lead_qualified',
        timestamp: new Date().toISOString()
      });
      
      // Informer les clients WebSocket
      broadcastMessage({
        type: 'lead_qualified',
        sessionId,
        callSid,
        timestamp: new Date().toISOString()
      });
      
    } else if (digits === '2' || speechResult.toLowerCase().includes('contacté')) {
      twiml.say({
        voice: 'Polly.Céline',
        language: 'fr-FR'
      }, 'Nous avons bien noté votre demande. Vous ne serez plus contacté par nos services. Au revoir.');
      
      // Marquer le prospect comme opt-out
      session.leadStatus = 'opt-out';
      session.events.push({
        type: 'opt_out',
        timestamp: new Date().toISOString()
      });
      
      // Informer les clients WebSocket
      broadcastMessage({
        type: 'opt_out',
        sessionId,
        callSid,
        timestamp: new Date().toISOString()
      });
      
    } else {
      twiml.say({
        voice: 'Polly.Céline',
        language: 'fr-FR'
      }, 'Je n\'ai pas compris votre réponse. Merci de votre attention, au revoir.');
      
      // Enregistrer la réponse non reconnue
      session.events.push({
        type: 'unrecognized_response',
        timestamp: new Date().toISOString()
      });
    }
    
    // Mettre à jour la session
    callSessions.set(sessionId, session);
    
    // Terminer l'appel
    twiml.hangup();
  }
  
  // Envoyer la réponse TwiML
  res.type('text/xml');
  res.send(twiml.toString());
});

// Route pour gérer l'absence de réponse
app.post('/api/twilio/no-input', (req, res) => {
  console.log('Aucune entrée utilisateur:', req.body);
  
  const sessionId = req.query.sessionId;
  const callSid = req.body.CallSid;
  
  // Récupérer la session
  const session = callSessions.get(sessionId);
  
  // Créer une réponse TwiML
  const twiml = new twilio.twiml.VoiceResponse();
  
  if (session) {
    // Enregistrer l'absence de réponse
    session.events.push({
      type: 'no_input',
      timestamp: new Date().toISOString()
    });
    callSessions.set(sessionId, session);
    
    // Informer les clients WebSocket
    broadcastMessage({
      type: 'no_input',
      sessionId,
      callSid,
      timestamp: new Date().toISOString()
    });
  }
  
  twiml.say({
    voice: 'Polly.Céline',
    language: 'fr-FR'
  }, 'Nous n\'avons pas reçu de réponse. Nous vous recontacterons ultérieurement. Au revoir.');
  
  twiml.hangup();
  
  // Envoyer la réponse TwiML
  res.type('text/xml');
  res.send(twiml.toString());
});

// Route pour les callbacks de statut Twilio
app.post('/api/twilio/status-callback', (req, res) => {
  console.log('Callback de statut Twilio reçu:', req.body);
  
  const sessionId = req.query.sessionId;
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  
  // Récupérer la session
  const session = callSessions.get(sessionId);
  
  if (session) {
    // Mettre à jour le statut
    session.status = callStatus;
    session.events.push({
      type: 'status_callback',
      status: callStatus,
      timestamp: new Date().toISOString()
    });
    callSessions.set(sessionId, session);
    
    // Informer les clients WebSocket
    broadcastMessage({
      type: 'call_status_update',
      sessionId,
      callSid,
      status: callStatus,
      timestamp: new Date().toISOString()
    });
  }
  
  // Répondre à Twilio
  res.status(200).send('OK');
});

// Route pour obtenir les données d'une session
app.get('/api/sessions/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  
  if (callSessions.has(sessionId)) {
    res.json(callSessions.get(sessionId));
  } else {
    res.status(404).json({ error: 'Session non trouvée' });
  }
});

// Route pour obtenir la liste des sessions actives
app.get('/api/sessions', (req, res) => {
  const activeSessions = {};
  
  callSessions.forEach((session, sessionId) => {
    activeSessions[sessionId] = {
      to: session.to,
      status: session.status,
      startTime: session.startTime,
      campaignId: session.campaignId,
      leadStatus: session.leadStatus
    };
  });
  
  res.json(activeSessions);
});

// ====== WEBSOCKET SERVER ======

// Gestion des connexions WebSocket
wss.on('connection', (ws, req) => {
  const id = generateUniqueId();
  const clientIP = req.socket.remoteAddress;
  
  console.log(`Nouvelle connexion: ${id} depuis ${clientIP}`);
  
  // Stocker le client avec son identifiant
  clients.set(id, ws);
  
  // Envoyer un message de bienvenue au client
  ws.send(JSON.stringify({
    type: 'connection_established',
    id: id,
    message: 'Connecté au serveur WebSocket avec Twilio'
  }));
  
  // Gestion des messages reçus
  ws.on('message', async (message) => {
    console.log(`Message reçu du client ${id}: ${message}`);
    
    try {
      const data = JSON.parse(message);
      
      // Traitement du message selon le type
      switch (data.type) {
        case 'echo':
          // Simple écho du message
          ws.send(JSON.stringify({
            type: 'echo_response',
            data: data.data,
            timestamp: new Date().toISOString()
          }));
          break;
          
        case 'broadcast':
          // Diffusion à tous les clients
          broadcastMessage({
            type: 'broadcast_message',
            from: id,
            data: data.data,
            timestamp: new Date().toISOString()
          });
          break;
          
        case 'direct':
          // Message direct à un client spécifique
          if (data.targetId && clients.has(data.targetId)) {
            const targetWs = clients.get(data.targetId);
            targetWs.send(JSON.stringify({
              type: 'direct_message',
              from: id,
              data: data.data,
              timestamp: new Date().toISOString()
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Client cible non trouvé',
              timestamp: new Date().toISOString()
            }));
          }
          break;
          
        case 'openai':
          // Appel à l'API OpenAI
          if (data.prompt) {
            // Appel asynchrone pour ne pas bloquer le thread principal
            callOpenAI(data.prompt, ws);
          } else {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Le prompt est requis pour les appels OpenAI',
              timestamp: new Date().toISOString()
            }));
          }
          break;
          
        case 'initiate_call':
          // Initier un appel via Twilio
          if (!twilioClient) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Twilio non configuré sur le serveur',
              timestamp: new Date().toISOString()
            }));
            break;
          }
          
          if (!data.to) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Numéro de téléphone requis pour l\'appel',
              timestamp: new Date().toISOString()
            }));
            break;
          }
          
          try {
            // Créer une session d'appel
            const sessionId = generateUniqueId();
            
            // Stocker les informations de session
            callSessions.set(sessionId, {
              to: data.to,
              campaignId: data.campaignId || 'default',
              agentId: data.agentId || id,
              script: data.script || 'Bonjour, ceci est un appel de prospection.',
              status: 'initiating',
              startTime: new Date(),
              events: []
            });
            
            // Informer les clients WebSocket
            broadcastMessage({
              type: 'call_initiating',
              sessionId,
              to: data.to,
              campaignId: data.campaignId,
              agentId: data.agentId || id,
              timestamp: new Date().toISOString()
            });
            
            // Récupérer l'URL base du serveur
            const baseUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
            
            // Initier l'appel via Twilio
            const call = await twilioClient.calls.create({
              url: `${baseUrl}/api/twilio/twiml?sessionId=${sessionId}`,
              to: data.to,
              from: TWILIO_PHONE_NUMBER,
              statusCallback: `${baseUrl}/api/twilio/status-callback?sessionId=${sessionId}`,
              statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
              statusCallbackMethod: 'POST'
            });
            
            // Mettre à jour la session avec l'ID d'appel Twilio
            const session = callSessions.get(sessionId);
            session.twilioCallSid = call.sid;
            session.status = 'initiated';
            session.events.push({
              type: 'call_initiated',
              twilioCallSid: call.sid,
              timestamp: new Date().toISOString()
            });
            callSessions.set(sessionId, session);
            
            // Informer le client demandeur
            ws.send(JSON.stringify({
              type: 'call_initiated',
              sessionId,
              twilioCallSid: call.sid,
              timestamp: new Date().toISOString()
            }));
            
          } catch (error) {
            console.error('Erreur lors de l\'initiation de l\'appel:', error);
            ws.send(JSON.stringify({
              type: 'error',
              message: `Échec de l'initiation de l'appel: ${error.message}`,
              timestamp: new Date().toISOString()
            }));
          }
          break;
          
        case 'get_active_calls':
          // Renvoyer la liste des appels actifs
          const activeCalls = {};
          
          callSessions.forEach((session, sessionId) => {
            activeCalls[sessionId] = {
              to: session.to,
              status: session.status,
              startTime: session.startTime,
              campaignId: session.campaignId,
              leadStatus: session.leadStatus
            };
          });
          
          ws.send(JSON.stringify({
            type: 'active_calls_list',
            calls: activeCalls,
            timestamp: new Date().toISOString()
          }));
          break;
          
        case 'end_call':
          // Terminer un appel en cours
          if (data.sessionId && callSessions.has(data.sessionId)) {
            const session = callSessions.get(data.sessionId);
            
            if (session.twilioCallSid && twilioClient) {
              try {
                await twilioClient.calls(session.twilioCallSid)
                  .update({ status: 'completed' });
                
                session.status = 'completed_by_user';
                session.events.push({
                  type: 'call_ended_by_user',
                  timestamp: new Date().toISOString()
                });
                callSessions.set(data.sessionId, session);
                
                ws.send(JSON.stringify({
                  type: 'call_end_success',
                  sessionId: data.sessionId,
                  timestamp: new Date().toISOString()
                }));
                
                // Diffuser la mise à jour
                broadcastMessage({
                  type: 'call_ended',
                  sessionId: data.sessionId,
                  reason: 'user_terminated',
                  timestamp: new Date().toISOString()
                });
              } catch (error) {
                ws.send(JSON.stringify({
                  type: 'error',
                  message: `Échec de la terminaison d'appel: ${error.message}`,
                  timestamp: new Date().toISOString()
                }));
              }
            } else {
              ws.send(JSON.stringify({
                type: 'error',
                message: 'Impossible de terminer l\'appel: SID manquant ou Twilio non configuré',
                timestamp: new Date().toISOString()
              }));
            }
          } else {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Session non trouvée',
              timestamp: new Date().toISOString()
            }));
          }
          break;
          
        default:
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Type de message non reconnu',
            timestamp: new Date().toISOString()
          }));
      }
    } catch (error) {
      console.error(`Erreur de traitement du message: ${error.message}`);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Format de message invalide - JSON attendu',
        timestamp: new Date().toISOString()
      }));
    }
  });
  
  // Gestion de la fermeture de connexion
  ws.on('close', () => {
    console.log(`Client ${id} déconnecté`);
    clients.delete(id);
    
    // Informer les autres clients de la déconnexion
    broadcastMessage({
      type: 'client_disconnected',
      id: id,
      timestamp: new Date().toISOString()
    });
  });
  
  // Informer les autres clients de la nouvelle connexion
  broadcastMessage({
    type: 'client_connected',
    id: id,
    timestamp: new Date().toISOString()
  }, id); // Ne pas envoyer au client qui vient de se connecter
});

// Fonction pour diffuser un message à tous les clients
function broadcastMessage(message, excludeId = null) {
  const messageStr = JSON.stringify(message);
  
  clients.forEach((ws, id) => {
    if (id !== excludeId && ws.readyState === WebSocket.OPEN) {
      ws.send(messageStr);
    }
  });
}

// Fonction pour communiquer avec l'API OpenAI
async function callOpenAI(prompt, ws) {
  if (!OPENAI_API_KEY) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Clé API OpenAI non configurée sur le serveur',
      timestamp: new Date().toISOString()
    }));
    return;
  }

  try {
    // Informer le client que la requête commence
    ws.send(JSON.stringify({
      type: 'openai_request_started',
      timestamp: new Date().toISOString()
    }));

    // Appel à l'API OpenAI avec streaming
    const stream = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }],
      stream: true
    });

    // Traiter chaque partie de la réponse en streaming
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        ws.send(JSON.stringify({
          type: 'openai_stream',
          content: content,
          timestamp: new Date().toISOString()
        }));
      }
    }

    // Informer le client que la requête est terminée
    ws.send(JSON.stringify({
      type: 'openai_request_completed',
      timestamp: new Date().toISOString()
    }));

  } catch (error) {
    console.error('OpenAI API error:', error);
    ws.send(JSON.stringify({
      type: 'error',
      message: `Erreur lors de l'appel à l'API OpenAI: ${error.message}`,
      timestamp: new Date().toISOString()
    }));
  }
}

// Génération d'un identifiant unique pour chaque client ou session
function generateUniqueId() {
  return Math.random().toString(36).substring(2, 15) + 
         Math.random().toString(36).substring(2, 15);
}

// Démarrage du serveur
server.listen(PORT, () => {
  console.log(`Serveur WebSocket avec Twilio démarré sur le port ${PORT}`);
  console.log(`- WebSocket: ws://localhost:${PORT}`);
  console.log(`- API REST: http://localhost:${PORT}/api`);
  console.log(`- Twilio webhook: http://localhost:${PORT}/api/twilio/twiml`);
  
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.warn('⚠️  ATTENTION: Configuration Twilio manquante ou incomplète');
    console.warn('   Assurez-vous d\'avoir défini TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN et TWILIO_PHONE_NUMBER dans .env');
  }
  
  if (!OPENAI_API_KEY) {
    console.warn('⚠️  ATTENTION: Clé API OpenAI non configurée');
    console.warn('   Assurez-vous d\'avoir défini OPENAI_API_KEY dans .env');
  }
});