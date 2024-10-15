# telegram-notifier-cf-worker

A [Cloudflare Worker](https://workers.cloudflare.com/) that sends
[Telegram](https://telegram.org) notifications for [DAO
DAO](https://daodao.zone/) DAOs.

## Development

### Run locally

```sh
npm run dev
# OR
wrangler dev --local --persist
```

### Configuration

1. Make a new bot on Telegram with [BotFather](https://t.me/botfather) and get
   the token. Instructions
   [here](https://core.telegram.org/bots/tutorial#obtain-your-bot-token).

2. Set your new bot's webhook to wherever this worker is deployed. For example:

```sh
curl -v "https://api.telegram.org/bot{BOT_TOKEN}/setWebhook?url=https://telegram-notifier.dao-dao.workers.dev/telegram&secret_token={WEBHOOK_SECRET}"
```

3. Copy `wrangler.toml.example` to `wrangler.toml`.

4. Create D1 database for production:

```sh
npx wrangler d1 create telegram-notifier
```

5. Update the binding ID in `wrangler.toml`:

```toml
[[ d1_databases ]]
binding = "DB"
database_name = "telegram-notifier"
database_id = "<REPLACE DB_ID>"
```

6. Configure secrets:

```sh
echo <VALUE> | npx wrangler secret put BOT_TOKEN
echo <VALUE> | npx wrangler secret put WEBHOOK_SECRET
echo <VALUE> | npx wrangler secret put NOTIFY_API_KEY
```

## Deploy

```sh
npm run deploy
# OR
wrangler deploy
```
