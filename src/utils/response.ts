export const respond = (status: number, response?: Record<string, unknown>) =>
  new Response(response && JSON.stringify(response), {
    status,
  })

export const respondError = (status: number, error: string) =>
  respond(status, { error })
