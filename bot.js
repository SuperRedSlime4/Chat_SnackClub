import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";

import pino from "pino";
import fs from "fs";

const PREFIX = "/";
const WARN_LIMIT = 3;
const DATA_FILE = "./chatty-data.json";
const PHONE_NUMBER = "393780926670"; // prefisso internazionale, senza "+" o spazi

let data = { warns: {}, banned: [] };

if (fs.existsSync(DATA_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

    data = {
      warns: saved.warns ?? {},
      banned: saved.banned ?? []
    };
  } catch {
    console.log("Errore dati: uso archivio vuoto.");
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

function getTarget(message) {
  const context =
    message.message?.extendedTextMessage?.contextInfo ||
    message.message?.imageMessage?.contextInfo ||
    message.message?.videoMessage?.contextInfo ||
    {};

  if (context.mentionedJid?.length) {
    return context.mentionedJid[0];
  }

  return context.participant || null;
}

function normalizeJid(jid) {
  return jid?.split(":")[0];
}

function sameJid(a, b) {
  return normalizeJid(a) === normalizeJid(b);
}

function numberOf(jid) {
  return jid?.split("@")[0].split(":")[0] ?? "";
}

async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState("./session");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    markOnlineOnConnect: false
  });

  let pairingCodeRequested = false;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (
      !sock.authState.creds.registered &&
      !pairingCodeRequested &&
      (connection === "connecting" || Boolean(qr))
    ) {
      pairingCodeRequested = true;

      try {
        const code = await sock.requestPairingCode(PHONE_NUMBER);
        console.log(`\nCODICE WHATSAPP: ${code}\n`);
      } catch (error) {
        pairingCodeRequested = false;
        console.error("Errore nella richiesta del codice:", error);
      }
    }

    if (connection === "open") {
      console.log("Moderator Bot ONLINE!");
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;

      if (code !== DisconnectReason.loggedOut) {
        console.log("Riconnessione...");
        setTimeout(() => {
          startBot().catch(console.error);
        }, 3000);
      } else {
        console.log("Sessione scollegata. Elimina ./session e ricollega WhatsApp.");
      }
    }
  });

  // Rimuove chiunque rientri nel gruppo dopo essere stato bannato.
  sock.ev.on("group-participants.update", async (event) => {
    if (event.action !== "add") return;

    for (const jid of event.participants) {
      const isBanned = data.banned.some(bannedJid =>
        sameJid(bannedJid, jid)
      );

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

        if (!chat || !chat.endsWith("@g.us")) continue;

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
        const participants = metadata.participants;

        const senderInfo = participants.find(p => sameJid(p.id, sender));
        const isAdmin =
          senderInfo?.admin === "admin" ||
          senderInfo?.admin === "superadmin";

        const botInfo = participants.find(p =>
          sameJid(p.id, sock.user?.id)
        );

        const botIsAdmin =
          botInfo?.admin === "admin" ||
          botInfo?.admin === "superadmin";

        const reply = async (message, mentions = []) => {
          await sock.sendMessage(
            chat,
            { text: message, mentions },
            { quoted: msg }
          );
        };

        const target = getTarget(msg);

        const adminCommands = [
          "warn", "warns", "resetwarn", "ban", "kick",
          "promote", "demote", "tagall", "delete",
          "close", "open", "setname", "setdesc",
          "revokeinvite", "admins"
        ];

        if (adminCommands.includes(command) && !isAdmin) {
          await reply("⛔ Solo gli amministratori possono usare questo comando.");
          continue;
        }

        const targetCommands = [
          "warn", "warns", "resetwarn", "ban", "kick",
          "promote", "demote"
        ];

        if (targetCommands.includes(command) && !target) {
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

        if (
          targetCommands.includes(command) &&
          (targetInfo?.admin === "admin" ||
            targetInfo?.admin === "superadmin")
        ) {
          await reply("Non puoi usare questo comando su un AMMINISTRATORE.");
          continue;
        }

        const requiresBotAdmin = [
          "ban", "kick", "promote", "demote",
          "close", "open", "setname", "setdesc",
          "delete", "revokeinvite"
        ];

        if (requiresBotAdmin.includes(command) && !botIsAdmin) {
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
                `Al terzo warn scatterà l'espulsione.`,
                [target]
              );

              try {
                await sock.sendMessage(target, {
                  text: `⚠️ Hai ricevuto un WARN nel gruppo ${metadata.subject}.\nTotale: ${count}/${WARN_LIMIT}.`
                });
              } catch {
                // Il messaggio privato può fallire se l'utente non è raggiungibile.
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
            data.banned = [
              ...new Set([...data.banned, normalizeJid(target)])
            ];
            saveData();

            await sock.groupParticipantsUpdate(chat, [target], "remove");

            await reply(
              `🚫 @${numberOf(target)} è stato bannato.`,
              [target]
            );
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
            const context =
              msg.message?.extendedTextMessage?.contextInfo;

            if (!context?.stanzaId || !context?.participant) {
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
Critichiamo lo Snack Club, non le persone

1. CRITICA SÌ, ODIO NO 🤝
Critichiamo i contenuti, i video e le scelte di Webboh/Snack Club.
Vietati insulti pesanti, minacce, auguri di male.

2. SOLO SNACK CLUB 💬
Solo argomenti su Snack Club, Webboh e membri. Niente OT.

3. NIENTE PRIVACY 🔒
Mai condividere indirizzi, numeri, scuole, case o chat private di loro. È ban immediato.

4. PROVE, NON FAKE ⭐
Se posti una news o un drama, metti fonte o screen. Niente fake news inventate.

5. SPONSOR / PROMO 📢
Promo e sponsor solo nel gruppo dedicato. Fuori da lì è spam.

6. LINGUAGGIO 🗣️
Critiche ammesse, ma con rispetto tra di noi. Zero razzismo, omofobia e body shaming.

7. NO CONTENUTI 18+ 🔞
Vietati porno, gore o edit sessualizzati dei membri.

8. MEME SÌ 😂
Meme e ironie sullo Snack Club sono ammessi se non violano le regole sopra.

9. ADMIN 👑
Gli admin decidono. Se esageri, 1 Warn ⚠️. Al 3° Warn sei fuori.

10. FOTO UNA VISUAL 😉
Imposta le foto come visualizzabili una sola volta, tranne quando un admin ti chiede diversamente.

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
          // Ignora errori nell'invio della risposta di errore.
        }
      }
    }
  });
}

startBot().catch(console.error);
