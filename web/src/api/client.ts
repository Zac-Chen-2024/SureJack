/** 统一的 API 错误：带上后端返回的中文提示 */
export class ApiError extends Error {
  status: number
  constructor (status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T> (method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'include',   // 带上会话 cookie（同域，本来就会带，显式写明意图）
  })
  if (!res.ok) {
    let msg = `请求失败（${res.status}）`
    try { msg = (await res.json()).error ?? msg } catch { /* 响应不是 JSON，用默认文案 */ }
    throw new ApiError(res.status, msg)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

/**
 * 上传一个文件。
 *
 * 【故意不走 request】：multipart 的 Content-Type 必须带 boundary，而
 * boundary 是浏览器在序列化 FormData 时才生成的。手写这个头会让
 * boundary 对不上，后端解析出空的 multipart——所以这里**一个头都不设**，
 * 让浏览器自己填。
 */
async function upload<T> (url: string, file: File): Promise<T> {
  const form = new FormData()
  form.append('file', file, file.name)
  const res = await fetch(url, { method: 'POST', body: form, credentials: 'include' })
  if (!res.ok) {
    let msg = `上传失败（${res.status}）`
    try { msg = (await res.json()).error ?? msg } catch { /* 响应不是 JSON */ }
    throw new ApiError(res.status, msg)
  }
  return res.json() as Promise<T>
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  upload,
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
}
