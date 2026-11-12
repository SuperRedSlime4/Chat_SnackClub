import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";

import pino from "pino";
import fs from "node:fs";

const PREFIX = "/";
const WARN_LIMIT = 3;
const DATA_FILE = "./chatty-data.json";

// Esempio Italia: 393331234567 (senza +)
const PHONE_NUMBER = "393780926670";

let data = { warns: {}, banned: [] };
let reconnectTimer = null;
let starting = false;

if (fs.existsSync(DATA_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    data = {
      warns: saved.warns ?? {},
      banned: saved.banned ?? []
    };
  } catch (error) {
    console.error("Archivio dati non leggibile; uso archivio vuoto:", error.message);
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
      await useMultiFileAuthState("./session");

    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      markOnlineOnConnect: false
    });

    let pairingCodeRequested = false;
    let socketClosed = false;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Pairing code is requested when Baileys emits the QR event,
      // not when the connection is already open.
      if (
        qr &&
        !sock.authState.creds.registered &&
        !pairingCodeRequested
      ) {
        pairingCodeRequested = true;

        try {
          const code = await sock.requestPairingCode(PHONE_NUMBER);
          console.log(`\nCODICE WHATSAPP: ${code}`);
          console.log(
            "Inseriscilo subito in WhatsApp > Dispositivi collegati > Collega un dispositivo."
          );
        } catch (error) {
          pairingCodeRequested = false;
          console.error(
            "Richiesta codice pairing fallita:",
            error?.message || error
          );
        }
      }

      if (connection === "open") {
        console.log("Moderator Bot ONLINE!");
      }

      if (connection === "close") {
        socketClosed = true;

        const status = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = status === DisconnectReason.loggedOut;

        if (loggedOut) {
          console.log(
            "Sessione disconnessa. Elimina ./session e collega di nuovo WhatsApp."
          );
          return;
        }

        // restartRequired è normale durante alcuni passaggi di pairing:
        // si ricrea il socket usando le credenziali salvate.
        console.log(
          status === DisconnectReason.restartRequired
            ? "WhatsApp richiede il riavvio della connessione..."
            : `Connessione chiusa (${status ?? "errore sconosciuto"}).`
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

    sock.ev.on("group-participants.update", async (event) => {
      if (event.action !== "add") return;

      for (const jid of event.participants) {
        const banned = data.banned.some(savedJid => sameJid(savedJid, jid));
        if (!banned) continue;

        try {
          await sock.groupParticipantsUpdate(event.id, [jid], "remove");
        } catch (error) {
          console.error("Impossibile rimuovere l'utente bannato:", error.message);
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

          const parts = text.slice(PREFIX.length).trim().split(/\s+/);
          const command = parts.shift()?.toLowerCase();
          const args = parts;

          if (!command) continue;

          const sender =
            msg.key.participant ||
            msg.participant ||
            msg.key.remoteJid;

          const metadata = await sock.groupMetadata(chat);
          const participants = metadata.participants || [];
          const senderInfo = participants.find(p => sameJid(p.id, sender));
          const senderIsAdmin = isAdmin(senderInfo);

          const botInfo = participants.find(p =>
            sameJid(p.id, sock.user?.id)
          );
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
            await reply("Utente non trovato nel gruppo. Riprova.");
            continue;
          }

          if (targetCommands.has(command) && isAdmin(targetInfo)) {
            await reply("Non puoi usare questo comando su un amministratore.");
            continue;
          }

          const requiresBotAdmin = new Set([
            "ban", "kick", "promote", "demote",
            "close", "open", "setname", "setdesc",
            "delete", "revokeinvite"
          ]);

          if (requiresBotAdmin.has(command) && !botIsAdmin) {
            await reply("⚠️ Prima rendimi amministratore del gruppo.");
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
/delete (rispondi a un messaggio)
/close
/open
/setname nome
/setdesc descrizione
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
                  // L'invio privato può fallire se l'utente non è raggiungibile.
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
              await reply(`✅ WARN azzerati per @${numberOf(target)}.`, [target]);
              break;
            }

            case "ban": {
              data.banned = [
                ...new Set([...data.banned, normalizeJid(target)])
              ];
              saveData();
              await sock.groupParticipantsUpdate(chat, [target], "remove");
              await reply(`🚫 @${numberOf(target)} è stato bannato.`, [target]);
              break;
            }

            case "kick":
              await sock.groupParticipantsUpdate(chat, [target], "remove");
              await reply(`👢 @${numberOf(target)} è stato espulso.`, [target]);
              break;

            case "promote":
              await sock.groupParticipantsUpdate(chat, [target], "promote");
              await reply("✅ Utente promosso ad amministratore.");
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
                  text:
                    "📢 ATTENZIONE A TUTTI!\n\n" +
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
                  text:
                    "👑 AMMINISTRATORI:\n" +
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
Critichiamo lo Snack Club, non le persone.

1. Critica sì, odio no: critiche ai contenuti, niente minacce o insulti pesanti.
2. Solo argomenti su Snack Club, Webboh e membri.
3. Niente dati personali o chat private: violazioni possono portare al ban.
4. News e drama devono avere una fonte; niente notizie inventate.
5. Promo e sponsor solo nel gruppo dedicato.
6. Rispetto tra i membri: vietati razzismo, omofobia e body shaming.
7. Vietati contenuti pornografici o gore.
8. Meme ammessi se rispettano le regole.
9. Gli admin moderano il gruppo.
10. Rispetta le richieste degli admin sulle immagini.

3 WARN = ESPULSIONE.`
              );
              break;

            default:
              await reply("Comando non riconosciuto. Scrivi /help per vedere i comandi.");
          }
        } catch (error) {
          console.error("Errore comando:", error);

          try {
            await sock.sendMessage(msg.key.remoteJid, {
              text: "❌ Errore durante l'esecuzione del comando."
            });
          } catch {
            // Ignora errori durante l'invio del messaggio di errore.
          }
        }
      }
    });

    // Evita variabili inutilizzate e chiarisce che il socket locale resta gestito
    // dai listener finché Baileys non emette connection: close.
    void socketClosed;
  } catch (error) {
    starting = false;
    throw error;
  }
}

startBot().catch(console.error);
