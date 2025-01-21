import { objectMatchesStructure } from './objectMatchesStructure'

export const escapeMarkdownV2 = (text: string) =>
  text.replace(/[\\_*\[\]\(\)~`>#+-=\|{}\.!]/g, '\\$&')

export type DaoInfo = {
  chainId: string
  url: string
  value: {
    config: {
      name: string
    }
  }
}

export const getDaoInfo = async (dao: string): Promise<DaoInfo | null> => {
  const info = await fetch(
    `https://snapper.indexer.zone/q/daodao-dao-info?address=${dao}`
  )
    .then((r) => r.json())
    .catch(() => null)

  if (
    !objectMatchesStructure(info, {
      chainId: {},
      url: {},
      value: {
        config: {
          name: {},
        },
      },
    })
  ) {
    return null
  }

  return info as DaoInfo
}
