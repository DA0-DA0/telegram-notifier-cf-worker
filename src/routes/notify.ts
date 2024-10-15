import { Request } from 'itty-router'
import { Env, RegistrationRow } from '../types'
import { escapeMarkdownV2, respond, respondError } from '../utils'
import removeMarkdown from 'remove-markdown'

const BATCH_SIZE = 10
const RETRIES = 3

const MAX_DESCRIPTION_LENGTH = 500

export const notify = async (request: Request, env: Env): Promise<Response> => {
  const { chainId, dao } = request.params ?? {}
  if (!chainId) {
    return respondError(400, 'Missing `chainId`.')
  }
  if (!dao) {
    return respondError(400, 'Missing `dao`.')
  }

  const {
    apiKey,
    daoName,
    proposalTitle,
    proposalDescription,
    proposalId,
    daoUrl,
    url,
  } = await request.json?.()

  let sanitizedDescription = removeMarkdown(proposalDescription)
  if (sanitizedDescription.length > MAX_DESCRIPTION_LENGTH) {
    sanitizedDescription =
      sanitizedDescription.slice(0, MAX_DESCRIPTION_LENGTH) + '...'
  }

  if (apiKey !== env.NOTIFY_API_KEY) {
    return respondError(401, 'Invalid API key.')
  }

  const { results: registrations = [] } = await env.DB.prepare(
    'SELECT chatId, messageThreadId FROM registrations WHERE chainId = ?1 AND dao = ?2'
  )
    .bind(chainId, dao)
    .all<Pick<RegistrationRow, 'chatId' | 'messageThreadId'>>()

  // Fire webhooks in batches.
  let succeeded = 0
  for (let i = 0; i < registrations.length; i += BATCH_SIZE) {
    const batch = registrations.slice(i, i + BATCH_SIZE)

    const responses = await Promise.all(
      batch.map(async ({ chatId, messageThreadId }) => {
        for (let i = RETRIES; i > 0; i--) {
          try {
            const response = await fetch(
              `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  chat_id: Number(chatId),
                  message_thread_id: messageThreadId
                    ? Number(messageThreadId)
                    : undefined,
                  parse_mode: 'MarkdownV2',
                  text: `_[Proposal ${escapeMarkdownV2(
                    proposalId
                  )}](${url}) is open for voting in [${escapeMarkdownV2(
                    daoName
                  )}](${daoUrl})\\._\n\n>*${escapeMarkdownV2(
                    proposalTitle
                  )}*\n>\n>${escapeMarkdownV2(sanitizedDescription)
                    .trim()
                    .split('\n')
                    .join('\n>')}`,
                  link_preview_options: {
                    is_disabled: true,
                  },
                }),
              }
            )
            console.log(
              `Sent notification to Telegram with chat_id/message_thread_id ${chatId}/${messageThreadId} for ${chainId}/${dao}. Status: ${
                response.status
              }. Response: ${await response.text().catch(() => '')}`
            )
            return true
          } catch (err) {
            // If retries left, continue.
            if (i > 1) {
              continue
            }

            // If out of retries, log and remove webhook.
            console.error(err)
            console.error(
              `Webhook for chat ID/message thread ID ${chatId}/${messageThreadId} failed 3 times for ${chainId}/${dao}. ${err}`
            )
            return false
          }
        }
      })
    )

    succeeded += responses.filter(Boolean).length
  }

  return respond(200, {
    success: true,
    count: succeeded,
  })
}
