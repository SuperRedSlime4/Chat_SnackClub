import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";

import pino from "pino";
import fs from "node:fs";

const PREFIX = "/";
const WARN_LIMIT = 3;
const DATA_FILE = "./chatty-data.json";
const SESSION_DIR = "./session";

// Numero internazionale senza +, spazi o parentesi.
const PHONE_NUMBER = "393780926670";

let data = { warns: {}, banned: [] };
let starting = false;
let reconnectTimer = null;

if (fs.existsSync(DATA_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    data = {
      warns: saved.warns ?? {},
      banned: saved.banned ?? []
    };
  } catch (error) {
    console.log("Errore dati: uso archivio vuoto.", error.message);
  }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getText(message) {
  const m = message.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ""
  );
}

function getContextInfo(message) {
  const m = message.message || {};
  return (
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    {}
  );
}

function getTarget(message) {
  const context = getContextInfo(message);
  return context.mentionedJid?.[0] || context.participant || null;
}

function normalizeJid(jid) {
  return jid?.split(":")[0] ?? "";
}

function sameJid(a, b) {
  return normalizeJid(a) === normalizeJid(b);
}

function numberOf(jid) {
  return jid?.split("@")[0].split(":")[0] ?? "";
}

function isAdmin(participant) {
  return participant?.admin === "admin" ||
    participant?.admin === "superadmin";
}

async function startBot() {
  if (starting) return;
  starting = true;

  try {
    const { state, saveCreds } =
      await useMultiFileAuthState(SESSION_DIR);

    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      markOnlineOnConnect: false
    });

    let pairingCodeRequested = false;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
      if (
        connection === "connecting" &&
        !sock.authState.creds.registered &&
        !pairingCodeRequested
      ) {
        pairingCodeRequested = true;

        try {
          const phone = PHONE_NUMBER.replace(/\D/g, "");
          const pairingCode = await sock.requestPairingCode(phone);
          console.log(`\nCODICE WHATSAPP: ${pairingCode}\n`);
          console.log(
            "Inseriscilo in WhatsApp > Dispositivi collegati > Collega un dispositivo > Collega con numero di telefono."
          );
        } catch (error) {
          pairingCodeRequested = false;
          console.error("Richiesta pairing code fallita:", error?.message || error);
        }
      }

      if (connection === "open") {
        console.log("Moderator Bot ONLINE!");
      }

      if (connection === "close") {
        const status = lastDisconnect?.error?.output?.statusCode;

        if (status === DisconnectReason.loggedOut) {
          console.log(
            "Sessione scollegata. Elimina la cartella ./session e collega di nuovo WhatsApp."
          );
          starting = false;
          return;
        }

        console.log(
          status === DisconnectReason.restartRequired
            ? "WhatsApp richiede il riavvio della connessione..."
            : "Connessione chiusa. Riconnessione..."
        );

        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            starting = false;
            startBot().catch(console.error);
          }, 3000);
        }
      }
    });

    // Rimuove dal gruppo gli utenti bannati se vengono aggiunti di nuovo.
    sock.ev.on("group-participants.update", async event => {
      if (event.action !== "add") return;

      for (const jid of event.participants) {
        const isBanned = data.banned.some(savedJid => sameJid(savedJid, jid));
        if (!isBanned) continue;

        try {
          await sock.groupParticipantsUpdate(event.id, [jid], "remove");
        } catch (error) {
          console.log("Impossibile applicare il ban:", error.message);
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        try {
          const chat = msg.key.remoteJid;
          if (!chat?.endsWith("@g.us")) continue;

          const text = getText(msg).trim();
          if (!text.startsWith(PREFIX)) continue;

          const args = text.slice(PREFIX.length).trim().split(/\s+/);
          const command = args.shift()?.toLowerCase();
          if (!command) continue;

          const sender =
            msg.key.participant ||
            msg.participant ||
            msg.key.remoteJid;

          const metadata = await sock.groupMetadata(chat);
          const participants = metadata.participants || [];

          const senderInfo = participants.find(p => sameJid(p.id, sender));
          const senderIsAdmin = isAdmin(senderInfo);

          const botInfo = participants.find(p => sameJid(p.id, sock.user?.id));
          const botIsAdmin = isAdmin(botInfo);

          const reply = async (message, mentions = []) => {
            await sock.sendMessage(
              chat,
              { text: message, mentions },
              { quoted: msg }
            );
          };

          const target = getTarget(msg);

          const adminCommands = new Set([
            "warn", "warns", "resetwarn", "ban", "kick",
            "promote", "demote", "tagall", "delete",
            "close", "open", "setname", "setdesc",
            "revokeinvite", "admins"
          ]);

          if (adminCommands.has(command) && !senderIsAdmin) {
            await reply("⛔ Solo gli amministratori possono usare questo comando.");
            continue;
          }

          const targetCommands = new Set([
            "warn", "warns", "resetwarn", "ban", "kick",
            "promote", "demote"
          ]);

          if (targetCommands.has(command) && !target) {
            await reply("⚠️ Menziona un utente oppure rispondi a un suo messaggio.");
            continue;
          }

          if (target && sameJid(target, sock.user?.id)) {
            await reply("Non posso applicare questo comando a me stesso.");
            continue;
          }

          const targetInfo = target
            ? participants.find(p => sameJid(p.id, target))
            : null;

          if (target && !targetInfo) {
            await reply("Utente non trovato nel gruppo... Riprova.");
            continue;
          }

          if (targetCommands.has(command) && isAdmin(targetInfo)) {
            await reply("Non puoi usare questo comando su un AMMINISTRATORE.");
            continue;
          }

          const requiresBotAdmin = new Set([
            "ban", "kick", "promote", "demote",
            "close", "open", "setname", "setdesc",
            "delete", "revokeinvite"
          ]);

          if (requiresBotAdmin.has(command) && !botIsAdmin) {
            await reply("⚠️ Prima rendimi amministratore del gruppo!");
            continue;
          }

          switch (command) {
            case "help":
            case "comandi":
              await reply(
`🤖 Moderator Bot - COMANDI

👮 AMMINISTRATORI
/warn @utente
/warns @utente
/resetwarn @utente
/ban @utente
/kick @utente
/promote @utente
/demote @utente
/tagall
/delete (rispondi a un messaggio per eliminarlo)
/close - solo gli amministratori possono scrivere
/open - tutti possono rispondere
/setname nome - cambia nome gruppo
/setdesc descrizione - cambia descrizione
/revokeinvite
/admins

👥 TUTTI
/help
/link
/rules
/info`
              );
              break;

            case "warn": {
              const key = `${chat}_${normalizeJid(target)}`;
              data.warns[key] = (data.warns[key] || 0) + 1;
              const count = data.warns[key];

              if (count >= WARN_LIMIT) {
                data.banned = [
                  ...new Set([...data.banned, normalizeJid(target)])
                ];
                saveData();

                await reply(
                  `🚫 @${numberOf(target)} ha raggiunto ${WARN_LIMIT} WARN.\nEspulsione automatica!`,
                  [target]
                );

                await sock.groupParticipantsUpdate(chat, [target], "remove");
              } else {
                saveData();

                await reply(
                  `⚠️ +1 WARN assegnato a @${numberOf(target)}!\n` +
                  `Avvertimenti: ${count}/${WARN_LIMIT}\n` +
                  "Al terzo warn scatterà l'espulsione.",
                  [target]
                );

                try {
                  await sock.sendMessage(target, {
                    text: `⚠️ Hai ricevuto un WARN nel gruppo ${metadata.subject}.\nTotale: ${count}/${WARN_LIMIT}.`
                  });
                } catch {
                  // L'invio privato può non essere consentito o raggiungibile.
                }
              }
              break;
            }

            case "warns": {
              const key = `${chat}_${normalizeJid(target)}`;
              const count = data.warns[key] || 0;
              await reply(
                `📋 @${numberOf(target)} ha ${count}/${WARN_LIMIT} WARN.`,
                [target]
              );
              break;
            }

            case "resetwarn": {
              const key = `${chat}_${normalizeJid(target)}`;
              data.warns[key] = 0;
              saveData();
              await reply(
                `✅ WARN azzerati per @${numberOf(target)}.`,
                [target]
              );
              break;
            }

            case "ban": {
              const normalizedTarget = normalizeJid(target);
              data.banned = [
                ...new Set([...data.banned, normalizedTarget])
              ];
              saveData();

              await sock.groupParticipantsUpdate(chat, [target], "remove");
              await reply(
                `🚫 @${numberOf(target)} è stato bannato. Addio`,
                [target]
              );
              break;
            }

            case "kick":
              await sock.groupParticipantsUpdate(chat, [target], "remove");
              await reply(
                `👢 @${numberOf(target)} è stato espulso. Addio`,
                [target]
              );
              break;

            case "promote":
              await sock.groupParticipantsUpdate(chat, [target], "promote");
              await reply("✅ Utente promosso ad AMMINISTRATORE.");
              break;

            case "demote":
              await sock.groupParticipantsUpdate(chat, [target], "demote");
              await reply("✅ Privilegi amministrativi rimossi.");
              break;

            case "tagall": {
              const mentions = participants.map(p => p.id);
              await sock.sendMessage(
                chat,
                {
                  text: "📢 ATTENZIONE A TUTTI!\n\n" +
                    mentions.map(jid => `@${numberOf(jid)}`).join("\n"),
                  mentions
                },
                { quoted: msg }
              );
              break;
            }

            case "delete": {
              const context = getContextInfo(msg);

              if (!context.stanzaId || !context.participant) {
                await reply("Rispondi al messaggio che vuoi eliminare.");
                break;
              }

              await sock.sendMessage(chat, {
                delete: {
                  remoteJid: chat,
                  fromMe: false,
                  id: context.stanzaId,
                  participant: context.participant
                }
              });
              break;
            }

            case "close":
              await sock.groupSettingUpdate(chat, "announcement");
              await reply("🔒 Gruppo chiuso: solo gli admin possono scrivere.");
              break;

            case "open":
              await sock.groupSettingUpdate(chat, "not_announcement");
              await reply("🔓 Gruppo aperto a tutti.");
              break;

            case "setname": {
              const name = args.join(" ");
              if (!name) {
                await reply("Utilizzo: /setname Nuovo nome");
                break;
              }

              await sock.groupUpdateSubject(chat, name);
              await reply("✅ Nome del gruppo aggiornato.");
              break;
            }

            case "setdesc": {
              const desc = args.join(" ");
              if (!desc) {
                await reply("Utilizzo: /setdesc Nuova descrizione");
                break;
              }

              await sock.groupUpdateDescription(chat, desc);
              await reply("✅ Descrizione aggiornata.");
              break;
            }

            case "link": {
              const code = await sock.groupInviteCode(chat);
              await reply(`🔗 LINK DEL GRUPPO:\nhttps://chat.whatsapp.com/${code}`);
              break;
            }

            case "revokeinvite":
              await sock.groupRevokeInvite(chat);
              await reply("🔐 Link d'invito precedente revocato.");
              break;

            case "admins": {
              const admins = participants.filter(p => p.admin);
              const mentions = admins.map(p => p.id);

              await sock.sendMessage(
                chat,
                {
                  text: "👑 AMMINISTRATORI:\n" +
                    admins.map(p => `@${numberOf(p.id)}`).join("\n"),
                  mentions
                },
                { quoted: msg }
              );
              break;
            }

            case "info":
              await reply(
                `📊 INFORMAZIONI GRUPPO\n\n` +
                `Nome: ${metadata.subject}\n` +
                `Membri: ${participants.length}\n` +
                `Amministratori: ${participants.filter(p => p.admin).length}`
              );
              break;

            case "rules":
              await reply(
`📜 REGOLE DEL GRUPPO E DELLA COMMUNITY:
Critichiamo lo Snack Club, non le persone

1. CRITICA SÌ, ODIO NO 🤝
Critichiamo i contenuti, i video e le scelte di Webboh/Snack Club.
Vietati insulti pesanti, minacce, auguri di male

2. SOLO SNACK CLUB 💬
Solo argomenti su Snack Club, Webboh e membri. Niente OT.

3. NIENTE PRIVACY 🔒
Mai condividere indirizzi, numeri, scuole, case o chat private di loro. È ban immediato.

4. PROVE, NON FAKE ⭐
Se posti una news o un drama, metti fonte o screen. Niente fake news inventate

5. SPONSOR / PROMO 📢
Promo e sponsor _solo nel gruppo dedicato._ Fuori da lì è spam.

6. LINGUAGGIO 🗣️
Si può dire che fa schifo, cringe, copiato... ma con rispetto tra di noi. Zero razzismo, omofobia, body shaming.

7. NO CONTENUTI 18+ 🔞
Vietato porno, gore o edit sessualizzati dei membri.

8. MEME SÌ 😂
Meme, ironie e prese in giro sullo Snack Club sono ammessi se non violano le regole sopra.

9. ADMIN 👑
Gli Admin decidono. Se esageri, 1 Warn ⚠️. Al 3° Warn sei fuori.

10. FOTO UNA VISUAL 😉 
È essenziale impostare TUTTE le foto che condividete, esclusi casi di richieste degli amministratori
3 WARN = ESPULSIONE.`
              );
              break;

            default:
              await reply("Comando non riconosciuto. Scrivi /help per vedere i comandi.");
          }
        } catch (error) {
          console.error("Errore comando:", error);

          try {
            await sock.sendMessage(
              msg.key.remoteJid,
              { text: "❌ Errore durante l'esecuzione del comando." }
            );
          } catch {
            // Ignora errori durante l'invio del messaggio di errore.
          }
        }
      }
    });
  } catch (error) {
    starting = false;
    throw error;
  }
}

startBot().catch(console.error);
