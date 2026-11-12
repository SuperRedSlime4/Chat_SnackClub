import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";

import qrcode from "qrcode-terminal";
import pino from "pino";
import fs from "fs";

const PREFIX = "/";
const WARN_LIMIT = 3;

const DATA_FILE = "./chatty-data.json";

let data = { warns: {}, banned: [] };

if (fs.existsSync(DATA_FILE)) {
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
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
    {};

  if (context.mentionedJid?.length) {
    return context.mentionedJid[0];
  }

  if (context.participant) {
    return context.participant;
  }

  return null;
}

function numberOf(jid) {
  return jid.split("@")[0].split(":")[0];
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

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\nSCANSIONA QUESTO QR CON WHATSAPP:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("CHATTTY ONLINE!");
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;

      if (code !== DisconnectReason.loggedOut) {
        console.log("Riconnessione...");
        setTimeout(startBot, 3000);
      } else {
        console.log("Sessione scollegata. Ricollega WhatsApp.");
      }
    }
  });

  // Controlla chi entra: gli utenti bannati vengono rimossi.
  sock.ev.on("group-participants.update", async (event) => {
    if (event.action === "add") {
      for (const jid of event.participants) {
        if (data.banned.includes(jid)) {
          try {
            await sock.groupParticipantsUpdate(
              event.id, [jid], "remove"
            );
          } catch (e) {
            console.log("Impossibile applicare il ban:", e.message);
          }
        }
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

        const args = text.slice(1).trim().split(/\s+/);
        const command = args.shift()?.toLowerCase();

        const sender =
          msg.key.participant ||
          msg.participant ||
          msg.key.remoteJid;

        const metadata = await sock.groupMetadata(chat);

        const participants = metadata.participants;

        const senderInfo = participants.find(
          p => p.id === sender
        );

        const isAdmin =
          senderInfo?.admin === "admin" ||
          senderInfo?.admin === "superadmin";

        const botId = sock.user.id.split(":")[0] + "@s.whatsapp.net";

        const botInfo = participants.find(
          p => p.id.split(":")[0] === botId.split(":")[0]
        );

        const botIsAdmin =
          botInfo?.admin === "admin" ||
          botInfo?.admin === "superadmin";

        const reply = async (message, mentions = []) => {
          await sock.sendMessage(chat, {
            text: message,
            mentions
          }, { quoted: msg });
        };

        const target = getTarget(msg);

        const adminCommands = [
          "warn", "warns", "resetwarn", "ban", "kick",
          "promote", "demote", "tagall", "delete",
          "close", "open", "setname", "setdesc",
          "revokeinvite"
        ];

        if (adminCommands.includes(command) && !isAdmin) {
          await reply("⛔ Solo gli amministratori possono usare questo comando.");
          continue;
        }

        if (
          ["warn", "ban", "kick", "promote", "demote"].includes(command) &&
          !target
        ) {
          await reply("⚠️ Menziona un utente oppure rispondi a un suo messaggio.");
          continue;
        }

        if (target === sock.user.id) {
          await reply("Non posso applicare questo comando a me stesso.");
          continue;
        }

        if (target && !participants.some(p => p.id === target)) {
          await reply("Utente non trovato nel gruppo.");
          continue;
        }

        if (target) {
          const targetInfo = participants.find(p => p.id === target);

          if (
            ["warn", "ban", "kick", "promote", "demote"].includes(command) &&
            (targetInfo?.admin === "admin" ||
             targetInfo?.admin === "superadmin")
          ) {
            await reply("Non puoi usare questo comando su un amministratore.");
            continue;
          }
        }

        if (
          ["ban", "kick", "promote", "demote",
           "close", "open", "setname", "setdesc",
           "delete", "revokeinvite"].includes(command) &&
          !botIsAdmin
        ) {
          await reply("⚠️ Prima rendimi amministratore del gruppo!");
          continue;
        }

        switch (command) {

          case "help":
          case "comandi":
            await reply(
`🤖 CHATTTY - COMANDI

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

👥 TUTTI
/help
/link
/rules
/admins
/info`
            );
            break;

          case "warn": {
            const key = `${chat}_${target}`;

            data.warns[key] = (data.warns[key] || 0) + 1;

            const count = data.warns[key];

            if (count >= WARN_LIMIT) {
              data.banned = [...new Set([...data.banned, target])];
              saveData();

              await reply(
                `🚫 @${numberOf(target)} ha raggiunto 3 WARN.\nEspulsione automatica!`,
                [target]
              );

              await sock.groupParticipantsUpdate(
                chat, [target], "remove"
              );
            } else {
              saveData();

              await reply(
                `⚠️ WARN assegnato a @${numberOf(target)}!\n` +
                `Avvertimenti: ${count}/${WARN_LIMIT}\n` +
                `Al terzo warn scatterà l'espulsione.`,
                [target]
              );

              await sock.sendMessage(target, {
                text: `⚠️ Hai ricevuto un WARN nel gruppo ${metadata.subject}.\nTotale: ${count}/${WARN_LIMIT}.`
              });
            }
            break;
          }

          case "warns": {
            const key = `${chat}_${target}`;
            const count = data.warns[key] || 0;

            await reply(
              `📋 @${numberOf(target)} ha ${count}/${WARN_LIMIT} WARN.`,
              [target]
            );
            break;
          }

          case "resetwarn": {
            const key = `${chat}_${target}`;
            data.warns[key] = 0;
            saveData();

            await reply(
              `✅ WARN azzerati per @${numberOf(target)}.`,
              [target]
            );
            break;
          }

          case "ban": {
            data.banned = [...new Set([...data.banned, target])];
            saveData();

            await sock.groupParticipantsUpdate(
              chat, [target], "remove"
            );

            await reply(
              `🚫 @${numberOf(target)} è stato bannato.`,
              [target]
            );
            break;
          }

          case "kick": {
            await sock.groupParticipantsUpdate(
              chat, [target], "remove"
            );

            await reply(
              `👢 @${numberOf(target)} è stato espulso.`,
              [target]
            );
            break;
          }

          case "promote":
            await sock.groupParticipantsUpdate(
              chat, [target], "promote"
            );
            await reply("✅ Utente promosso ad amministratore.");
            break;

          case "demote":
            await sock.groupParticipantsUpdate(
              chat, [target], "demote"
            );
            await reply("✅ Privilegi amministrativi rimossi.");
            break;

          case "tagall": {
            const mentions = participants.map(p => p.id);

            await sock.sendMessage(chat, {
              text: "📢 ATTENZIONE A TUTTI!\n\n" +
                mentions.map(j => `@${numberOf(j)}`).join("\n"),
              mentions
            }, { quoted: msg });
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

          case "revokeinvite": {
            await sock.groupRevokeInvite(chat);
            await reply("🔐 Link d'invito precedente revocato.");
            break;
          }

          case "admins": {
            const admins = participants.filter(
              p => p.admin
            );

            const mentions = admins.map(p => p.id);

            await sock.sendMessage(chat, {
              text: "👑 AMMINISTRATORI:\n" +
                admins.map(p => `@${numberOf(p.id)}`).join("\n"),
              mentions
            }, { quoted: msg });
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
`📜 REGOLE DEL GRUPPO

1. Rispetta gli altri.
2. Non fare spam.
3. Niente contenuti inappropriati.
4. Segui le indicazioni degli admin.
5. Rispetta le decisioni di moderazione.

3 WARN = ESPULSIONE.`
            );
            break;
        }

      } catch (error) {
        console.error("Errore comando:", error);
        try {
          await sock.sendMessage(
            msg.key.remoteJid,
            { text: "❌ Errore durante l'esecuzione del comando." }
          );
        } catch {}
      }
    }
  });
}

startBot().catch(console.error);
