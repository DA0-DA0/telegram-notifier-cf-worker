import { Request as IttyRequest } from 'itty-router'
import { Env, RegistrationRow } from '../types'
import {
  escapeMarkdownV2,
  getDaoInfo,
  objectMatchesStructure,
  respond,
  respondError,
} from '../utils'

type TelegramUser = {
  id: number
  username: string
}

type TelegramChat = {
  // negative for groups
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title: string
  // if the chat is a supergroup AND has forum topics enabled
  is_forum?: boolean
}

type TelegramChatMember = {
  user: TelegramUser
} & (
  | {
      status: 'member' | 'administrator' | 'creator' | 'left' | 'kicked'
    }
  | {
      status: 'restricted'
      can_send_messages: boolean
    }
)

type TelegramMessage = {
  // will be defined if sent in a forum topic
  message_thread_id?: number
  chat: TelegramChat
  from: TelegramUser
  text?: string
  reply_to_message?: TelegramMessage
}

// https://core.telegram.org/bots/api#update
type TelegramWebhookData = {
  update_id: number

  // Only one of the following will be present, but leave them as not optional
  // for easy typing:

  // When a message is sent to the bot (command, reply, or private message)
  message: TelegramMessage

  // When the chat membership status changes
  my_chat_member: {
    chat: TelegramChat
    old_chat_member: TelegramChatMember
    new_chat_member: TelegramChatMember
  }
}

const WELCOME_GROUP_MESSAGE = `Hello\\! I'll send a message when there are new proposals in DAOs you track\\. Use the following command to start tracking a DAO:\n\n\`/add@dao\\_dao\\_notifier\\_bot DAO\\_ADDRESS\``

const WELCOME_FORUM_MESSAGE = `Hello\\! I'll send a message when there are new proposals in DAOs you track\\. Use the following command in any topic thread to start tracking a DAO:\n\n\`/add@dao\\_dao\\_notifier\\_bot DAO\\_ADDRESS\``

const WELCOME_PRIVATE_MESSAGE = `Hello\\! I'll send a message when there are new proposals in DAOs you track\\. You can add me to group chats to track proposals with others, or just use me in private\\.\n\nUse the following command to start tracking a DAO in this chat:\n\n\`/add@dao\\_dao\\_notifier\\_bot DAO\\_ADDRESS\``

const BOT_USERNAME = 'dao_dao_notifier_bot'

export const telegram = async (
  request: IttyRequest & Request,
  env: Env
): Promise<Response> => {
  const webhookSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token')
  if (webhookSecret !== env.WEBHOOK_SECRET) {
    return respondError(401, 'Invalid webhook secret.')
  }

  const data: TelegramWebhookData = await request.json?.()

  let chatId: number | undefined
  let messageThreadId: number | undefined

  const respondPlain = (text: string) => {
    if (chatId === undefined) {
      console.error('chatId is undefined. could not send message', text)
      return respond(200)
    }

    return respond(200, {
      method: 'sendMessage',
      chat_id: chatId,
      message_thread_id: messageThreadId,
      text,
    })
  }
  const respondMarkdown = (text: string) => {
    if (chatId === undefined) {
      console.error('chatId is undefined. could not send message', text)
      return respond(200)
    }

    return respond(200, {
      method: 'sendMessage',
      chat_id: chatId,
      message_thread_id: messageThreadId,
      parse_mode: 'MarkdownV2',
      text,
      link_preview_options: {
        is_disabled: true,
      },
    })
  }

  try {
    if (
      objectMatchesStructure(data, {
        my_chat_member: {
          chat: {
            id: {},
          },
          old_chat_member: {
            status: {},
          },
          new_chat_member: {
            status: {},
          },
        },
      })
    ) {
      // set chat ID, no message thread ID since this is a membership update
      // that applies to the whole group, not just a specific thread
      chatId = data.my_chat_member.chat.id

      // if removed from chat, unregister all DAOs for this chat (in any topic)
      if (
        data.my_chat_member.new_chat_member.status === 'left' ||
        data.my_chat_member.new_chat_member.status === 'kicked'
      ) {
        console.log(
          `removing all registrations for chat ${data.my_chat_member.chat.id} since bot now has ${data.my_chat_member.new_chat_member.status} status`
        )

        await env.DB.prepare('DELETE FROM registrations WHERE chatId = ?1')
          .bind(BigInt(data.my_chat_member.chat.id).toString())
          .run()
      }
      // if bot is restricted and cannot send messages, complain
      else if (
        data.my_chat_member.new_chat_member.status === 'restricted' &&
        !data.my_chat_member.new_chat_member.can_send_messages
      ) {
        console.log(
          `bot is restricted and cannot send messages in chat ${data.my_chat_member.chat.id}`
        )
      }
      // if bot is added to chat, send welcome message
      else if (
        (data.my_chat_member.old_chat_member.status === 'left' ||
          data.my_chat_member.old_chat_member.status === 'kicked') &&
        (data.my_chat_member.new_chat_member.status === 'member' ||
          data.my_chat_member.new_chat_member.status === 'administrator' ||
          data.my_chat_member.new_chat_member.status === 'creator')
      ) {
        console.log(`bot is added to chat ${data.my_chat_member.chat.id}`)

        return respondMarkdown(
          data.my_chat_member.chat.type === 'private'
            ? WELCOME_PRIVATE_MESSAGE
            : data.my_chat_member.chat.is_forum
            ? WELCOME_FORUM_MESSAGE
            : WELCOME_GROUP_MESSAGE
        )
      }
    } else if (
      objectMatchesStructure(data, {
        message: { chat: { id: {} }, text: {} },
      }) &&
      data.message.text
    ) {
      chatId = data.message.chat.id
      messageThreadId = data.message.message_thread_id ?? undefined

      // if not a private chat, verify that sender is admin or owner.
      if (data.message.chat.type !== 'private') {
        const admins = await fetch(
          `https://api.telegram.org/bot${env.BOT_TOKEN}/getChatAdministrators?chat_id=${chatId}`
        )
          .then((r) =>
            r.json<{
              ok: boolean
              result: TelegramChatMember[]
            }>()
          )
          .catch(() => ({ ok: false, result: [] }))

        const isAdmin =
          !!admins.ok &&
          admins.result.some(
            (admin) =>
              admin.user.id === data.message.from.id &&
              (admin.status === 'administrator' || admin.status === 'creator')
          )

        // Do nothing if not admin. Sending an error message means non-admins
        // could spam the chat with error messages.
        if (!isAdmin) {
          return respond(200)
        }
      }

      if (data.message.text.startsWith('/start')) {
        return respondMarkdown(
          data.message.chat.type === 'private'
            ? WELCOME_PRIVATE_MESSAGE
            : data.message.chat.is_forum
            ? WELCOME_FORUM_MESSAGE
            : WELCOME_GROUP_MESSAGE
        )
      }

      if (data.message.text.startsWith('/help')) {
        return respondMarkdown(
          `Here's how to use me:\n\n` +
            [
              `– Send \`/add@dao\\_dao\\_notifier\\_bot DAO\\_ADDRESS\` to start tracking a DAO\\.`,
              `– Send \`/remove@dao\\_dao\\_notifier\\_bot DAO\\_ADDRESS\` to stop tracking a DAO\\.`,
              `– Send /list@dao\\_dao\\_notifier\\_bot to see all the DAOs you're tracking\\.`,
              `– Send /help@dao\\_dao\\_notifier\\_bot to get this message\\.`,
            ].join('\n')
        )
      }

      if (data.message.text.startsWith('/list')) {
        const { results: registrations = [] } = await env.DB.prepare(
          `SELECT dao FROM registrations WHERE chatId = ?1 AND messageThreadId ${
            data.message.message_thread_id !== undefined ? '= ?2' : 'IS NULL'
          }`
        )
          .bind(
            BigInt(data.message.chat.id).toString(),
            ...(data.message.message_thread_id !== undefined
              ? [BigInt(data.message.message_thread_id).toString()]
              : [])
          )
          .all<Pick<RegistrationRow, 'dao'>>()

        if (registrations.length === 0) {
          return respondMarkdown(
            `You're not tracking any DAOs\\.\n\nSend \`/add@dao\\_dao\\_notifier\\_bot DAO\\_ADDRESS\` to start tracking a DAO\\.`
          )
        }

        const registrationList = await Promise.all(
          registrations.map(async ({ dao }) => {
            const info = await getDaoInfo(dao)
            return info
              ? `– [${escapeMarkdownV2(info.value.config.name)}](${info.url})`
              : `– ${dao}`
          })
        )

        return respondMarkdown(
          `You're tracking the following DAOs:\n\n${registrationList.join(
            '\n'
          )}`
        )
      }

      let dao
      if (
        data.message.text.startsWith('/add') ||
        data.message.text.startsWith('/remove')
      ) {
        dao = data.message.text.split(' ')[1]?.trim()
        if (!dao) {
          return respondPlain(
            "Reply to this message with the DAO's address or a link to its page."
          )
        }
      } else {
        // if not in a private chat, only process a non-command message if not
        // replying to one of this bot's messages. this ensure it doesn't
        // attempt to respond to all group messages.
        if (
          data.message.chat.type !== 'private' &&
          data.message.reply_to_message?.from.username !== BOT_USERNAME
        ) {
          return respond(200)
        }

        dao = data.message.text.match(
          /(?:https:\/\/)?(?:testnet\.)?(?:daodao\.zone\/dao\/)?([a-zA-Z0-9]+)/
        )?.[1]

        if (!dao) {
          return respondPlain(
            "I don't recognize the DAO address or link provided. Please try again."
          )
        }
      }

      const info = await getDaoInfo(dao)

      if (info) {
        const existing = await env.DB.prepare(
          `SELECT * FROM registrations WHERE chainId = ?1 AND dao = ?2 AND chatId = ?3 AND messageThreadId ${
            data.message.message_thread_id !== undefined ? '= ?4' : 'IS NULL'
          }`
        )
          .bind(
            info.chainId,
            dao,
            BigInt(data.message.chat.id).toString(),
            ...(data.message.message_thread_id !== undefined
              ? [BigInt(data.message.message_thread_id).toString()]
              : [])
          )
          .first()

        // remove
        if (data.message.text.startsWith('/remove@')) {
          if (existing) {
            await env.DB.prepare(
              `DELETE FROM registrations WHERE dao = ?1 AND chatId = ?2 AND messageThreadId ${
                data.message.message_thread_id !== undefined
                  ? '= ?3'
                  : 'IS NULL'
              }`
            )
              .bind(
                dao,
                BigInt(data.message.chat.id).toString(),
                ...(data.message.message_thread_id !== undefined
                  ? [BigInt(data.message.message_thread_id).toString()]
                  : [])
              )
              .run()

            return respondMarkdown(
              `Ok, you're no longer tracking [${escapeMarkdownV2(
                info.value.config.name
              )}](${
                info.url
              })\\.\n\nSend \`/add@dao\\_dao\\_notifier\\_bot ${dao}\` to track it again\\.`
            )
          } else {
            return respondMarkdown(
              `You're not tracking [${escapeMarkdownV2(
                info.value.config.name
              )}](${
                info.url
              })\\.\n\nSend \`/add@dao\\_dao\\_notifier\\_bot ${dao}\` to track it\\.`
            )
          }
        }

        // add
        else {
          if (existing) {
            return respondMarkdown(
              `You're already tracking [${escapeMarkdownV2(
                info.value.config.name
              )}](${
                info.url
              })\\! I'll notify you when there are new proposals\\.\n\nSend \`/remove@dao\\_dao\\_notifier\\_bot ${dao}\` to stop tracking it\\.`
            )
          }

          await env.DB.prepare(
            'INSERT INTO registrations (chainId, dao, chatId, messageThreadId) VALUES (?1, ?2, ?3, ?4)'
          )
            .bind(
              info.chainId,
              dao,
              BigInt(data.message.chat.id).toString(),
              data.message.message_thread_id !== undefined
                ? BigInt(data.message.message_thread_id).toString()
                : null
            )
            .run()

          return respondMarkdown(
            `Got it\\! I'll notify you when there are new proposals in [${escapeMarkdownV2(
              info.value.config.name
            )}](${
              info.url
            })\\.\n\nSend \`/remove@dao\\_dao\\_notifier\\_bot ${dao}\` to stop tracking it\\.`
          )
        }
      } else {
        return respondPlain(
          "I couldn't find a DAO with that address. Try copying the URL from your browser and using that instead."
        )
      }
    }
  } catch (err) {
    console.error(
      'failed to process webhook',
      err,
      JSON.stringify(data, null, 2)
    )

    return respondPlain(
      `An unexpected error ocurred. Please try again or contact the team for support.`
    )
  }

  return respond(200)
}
