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
  text: string
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

const BOT_USERNAME = 'dao_dao_notifier_bot'
const REPLY_ADD_INSTRUCTIONS =
  "Reply to this message with the DAO's address or a link to its page to start tracking it."
const REPLY_REMOVE_INSTRUCTIONS =
  "Reply to this message with the DAO's address or a link to its page to stop tracking it."

const NO_RESPONSE = respond(200)

export const telegram = async (
  request: IttyRequest & Request,
  env: Env
): Promise<Response> => {
  const webhookSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token')
  if (webhookSecret !== env.WEBHOOK_SECRET) {
    return respondError(401, 'Invalid webhook secret.')
  }

  const data: TelegramWebhookData = await request.json?.()

  const isBotMembershipChange = objectMatchesStructure(data, {
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

  const isMessage =
    objectMatchesStructure(data, {
      message: { chat: { id: {} }, text: {} },
    }) && !!data.message.text

  const chat = isBotMembershipChange
    ? data.my_chat_member.chat
    : isMessage
    ? data.message.chat
    : undefined

  if (!chat) {
    console.error('chat is undefined. cannot respond to this request')
    return NO_RESPONSE
  }

  // no message thread ID for membership changes
  const messageThreadId = isMessage
    ? data.message.message_thread_id ?? undefined
    : undefined

  const respondPlain = (text: string) => {
    return respond(200, {
      method: 'sendMessage',
      chat_id: chat.id,
      message_thread_id: messageThreadId,
      text,
    })
  }
  const respondMarkdown = (text: string) => {
    return respond(200, {
      method: 'sendMessage',
      chat_id: chat.id,
      message_thread_id: messageThreadId,
      parse_mode: 'MarkdownV2',
      text,
      link_preview_options: {
        is_disabled: true,
      },
    })
  }

  // in private chats, no need to mention the bot. in groups, commands need to
  // directly mention the bot to work.
  const suffix =
    chat.type === 'private' ? '' : '@' + escapeMarkdownV2(BOT_USERNAME)

  const HELP_TEXT =
    `Here's how to use me:\n\n` +
    [
      `/add${suffix} \\- start tracking a DAO`,
      `/remove${suffix} \\- stop tracking a DAO`,
      `/list${suffix} \\- list your tracked DAOs`,
      `/help${suffix} \\- see this message again`,
    ].join('\n')

  const WELCOME_GROUP_MESSAGE = `Hello\\! I'll send a message when there are new proposals in DAOs you track\\. ${HELP_TEXT}\n\n_Only admins or owners can use the commands above_\\.`

  const WELCOME_PRIVATE_MESSAGE = `Hello\\! I'll send a message when there are new proposals in DAOs you track\\. You can add me to group chats to track proposals with others, or just use me in private\\. ${HELP_TEXT}`

  try {
    if (isBotMembershipChange) {
      const { old_chat_member: oldChatMember, new_chat_member: newChatMember } =
        data.my_chat_member

      // if removed from chat, unregister all DAOs for this chat (in any topic)
      if (
        newChatMember.status === 'left' ||
        newChatMember.status === 'kicked'
      ) {
        console.log(
          `removing all registrations for chat ${chat.id} since bot now has ${newChatMember.status} status`
        )

        await env.DB.prepare('DELETE FROM registrations WHERE chatId = ?1')
          .bind(BigInt(chat.id).toString())
          .run()
      }
      // if bot is restricted and cannot send messages, complain
      else if (
        newChatMember.status === 'restricted' &&
        !newChatMember.can_send_messages
      ) {
        console.log(
          `bot is restricted and cannot send messages in chat ${chat.id}`
        )
      }
      // if bot is added to chat, send welcome message
      else if (
        (oldChatMember.status === 'left' ||
          oldChatMember.status === 'kicked') &&
        (newChatMember.status === 'member' ||
          newChatMember.status === 'administrator' ||
          newChatMember.status === 'creator')
      ) {
        console.log(`bot is added to chat ${chat.id}`)

        return respondMarkdown(
          chat.type === 'private'
            ? WELCOME_PRIVATE_MESSAGE
            : WELCOME_GROUP_MESSAGE
        )
      }
    } else if (isMessage) {
      const text = data.message.text

      // if not a private chat, verify that sender is admin or owner.
      if (chat.type !== 'private') {
        const admins = await fetch(
          `https://api.telegram.org/bot${env.BOT_TOKEN}/getChatAdministrators?chat_id=${chat.id}`
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
          return NO_RESPONSE
        }
      }

      if (text.startsWith('/start')) {
        return respondMarkdown(
          chat.type === 'private'
            ? WELCOME_PRIVATE_MESSAGE
            : WELCOME_GROUP_MESSAGE
        )
      }

      if (text.startsWith('/help')) {
        return respondMarkdown(HELP_TEXT)
      }

      if (text.startsWith('/list')) {
        const { results: registrations = [] } = await env.DB.prepare(
          `SELECT dao FROM registrations WHERE chatId = ?1 AND messageThreadId ${
            messageThreadId !== undefined ? '= ?2' : 'IS NULL'
          }`
        )
          .bind(
            BigInt(chat.id).toString(),
            ...(messageThreadId !== undefined
              ? [BigInt(messageThreadId).toString()]
              : [])
          )
          .all<Pick<RegistrationRow, 'dao'>>()

        if (registrations.length === 0) {
          return respondMarkdown(
            `You're not tracking any DAOs\\.\n\nSend /add${suffix} to start tracking a DAO\\.`
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

      let isAdd = text.startsWith('/add')
      let isRemove = text.startsWith('/remove')

      // if neither add nor remove command detected, auto-detect based on reply
      if (!isAdd && !isRemove) {
        const replyToMessage = data.message.reply_to_message

        if (!replyToMessage || replyToMessage.from.username !== BOT_USERNAME) {
          return NO_RESPONSE
        }

        isAdd =
          replyToMessage.text.startsWith('/add') ||
          replyToMessage.text === REPLY_ADD_INSTRUCTIONS
        isRemove =
          replyToMessage.text.startsWith('/remove') ||
          replyToMessage.text === REPLY_REMOVE_INSTRUCTIONS

        if (!isAdd && !isRemove) {
          return NO_RESPONSE
        }
      }

      const dao = text
        .replace(/^(\/add|\/remove)(@dao_dao_notifier_bot)?\s*/i, '')
        .match(
          /(?:https:\/\/)?(?:testnet\.)?(?:daodao\.zone\/dao\/)?([a-zA-Z0-9]+)/
        )?.[1]

      if (!dao) {
        if (isAdd) {
          return respondPlain(REPLY_ADD_INSTRUCTIONS)
        } else if (isRemove) {
          return respondPlain(REPLY_REMOVE_INSTRUCTIONS)
        }

        // shouldn't happen
        return NO_RESPONSE
      }

      const info = await getDaoInfo(dao)

      if (info) {
        const existing = await env.DB.prepare(
          `SELECT * FROM registrations WHERE chainId = ?1 AND dao = ?2 AND chatId = ?3 AND messageThreadId ${
            messageThreadId !== undefined ? '= ?4' : 'IS NULL'
          }`
        )
          .bind(
            info.chainId,
            dao,
            BigInt(chat.id).toString(),
            ...(messageThreadId !== undefined
              ? [BigInt(messageThreadId).toString()]
              : [])
          )
          .first()

        if (isAdd) {
          if (existing) {
            return respondMarkdown(
              `You're already tracking [${escapeMarkdownV2(
                info.value.config.name
              )}](${
                info.url
              })\\! I'll notify you when there are new proposals\\.\n\nSend \`/remove${suffix} ${dao}\` to stop tracking it\\.`
            )
          }

          await env.DB.prepare(
            'INSERT INTO registrations (chainId, dao, chatId, messageThreadId) VALUES (?1, ?2, ?3, ?4)'
          )
            .bind(
              info.chainId,
              dao,
              BigInt(chat.id).toString(),
              messageThreadId !== undefined
                ? BigInt(messageThreadId).toString()
                : null
            )
            .run()

          return respondMarkdown(
            `Got it\\! I'll notify you when there are new proposals in [${escapeMarkdownV2(
              info.value.config.name
            )}](${
              info.url
            })\\.\n\nSend \`/remove${suffix} ${dao}\` to stop tracking it\\.`
          )
        }

        if (isRemove) {
          if (existing) {
            await env.DB.prepare(
              `DELETE FROM registrations WHERE dao = ?1 AND chatId = ?2 AND messageThreadId ${
                messageThreadId !== undefined ? '= ?3' : 'IS NULL'
              }`
            )
              .bind(
                dao,
                BigInt(chat.id).toString(),
                ...(messageThreadId !== undefined
                  ? [BigInt(messageThreadId).toString()]
                  : [])
              )
              .run()

            return respondMarkdown(
              `Ok, you're no longer tracking [${escapeMarkdownV2(
                info.value.config.name
              )}](${
                info.url
              })\\.\n\nSend \`/add${suffix} ${dao}\` to track it again\\.`
            )
          } else {
            return respondMarkdown(
              `You're not tracking [${escapeMarkdownV2(
                info.value.config.name
              )}](${
                info.url
              })\\.\n\nSend \`/add${suffix} ${dao}\` to track it\\.`
            )
          }
        }
      } else {
        return respondPlain(
          "I don't recognize the DAO address or link provided. Try replying to the original message with the URL copied from your browser."
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

  return NO_RESPONSE
}
