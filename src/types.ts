export interface Env {
  DB: D1Database

  // Secrets.
  BOT_TOKEN: string
  WEBHOOK_SECRET: string
  NOTIFY_API_KEY: string
}

export type RegistrationRow = {
  chainId: string
  dao: string
  chatId: string
  messageThreadId: string | null
}
