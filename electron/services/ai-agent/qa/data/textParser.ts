import * as fzstd from 'fzstd'
import type { AgentChatRecordItem, AgentMessageKind, AgentSourceMessage } from './models'

function decodeHtmlEntities(content: string): string {
  const decodeCodePoint = (value: string, radix: 10 | 16, fallback: string): string => {
    const codePoint = Number.parseInt(value, radix)
    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10FFFF) return fallback
    try {
      return String.fromCodePoint(codePoint)
    } catch {
      return fallback
    }
  }

  return String(content || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (entity, hex) => decodeCodePoint(hex, 16, entity))
    .replace(/&#(\d+);/g, (entity, dec) => decodeCodePoint(dec, 10, entity))
}

function stripSenderPrefix(content: string): string {
  return content.replace(/^[\s]*([a-zA-Z0-9_-]+):(?!\/\/)\s*/, '')
}

function looksLikeHex(value: string): boolean {
  return /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0
}

function looksLikeBase64(value: string): boolean {
  return /^[A-Za-z0-9+/=]+$/.test(value) && value.length % 4 === 0
}

export function extractXmlValue(xml: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i')
  const match = regex.exec(String(xml || ''))
  if (!match) return ''
  return decodeHtmlEntities(match[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim())
}

export function extractXmlAttribute(xml: string, tagName: string, attrName: string): string {
  const tagRegex = new RegExp(`<${tagName}\\b[^>]*>`, 'i')
  const tagMatch = tagRegex.exec(String(xml || ''))
  if (!tagMatch) return ''
  const attrRegex = new RegExp(`${attrName}\\s*=\\s*["']([^"']*)["']`, 'i')
  return decodeHtmlEntities(attrRegex.exec(tagMatch[0])?.[1] || '')
}

function decodeBinaryContent(data: Buffer): string {
  if (data.length === 0) return ''

  try {
    if (data.length >= 4 && data.readUInt32LE(0) === 0xfd2fb528) {
      try {
        const decompressed = fzstd.decompress(data)
        return Buffer.from(decompressed).toString('utf-8')
      } catch {
        return ''
      }
    }

    const decoded = data.toString('utf-8')
    const replacementCount = (decoded.match(/\uFFFD/g) || []).length
    if (replacementCount < decoded.length * 0.2) {
      return decoded.replace(/\uFFFD/g, '')
    }

    return data.toString('latin1')
  } catch {
    return ''
  }
}

function decodeMaybeCompressed(raw: unknown): string {
  if (!raw) return ''

  if (Buffer.isBuffer(raw)) return decodeBinaryContent(raw)
  if (raw instanceof Uint8Array) return decodeBinaryContent(Buffer.from(raw))

  if (typeof raw === 'string') {
    if (raw.length === 0) return ''
    if (raw.length > 16 && looksLikeHex(raw)) {
      return decodeBinaryContent(Buffer.from(raw, 'hex'))
    }
    if (raw.length > 16 && looksLikeBase64(raw)) {
      try {
        return decodeBinaryContent(Buffer.from(raw, 'base64'))
      } catch {
        return raw
      }
    }
    return raw
  }

  return ''
}

export function decodeMessageContent(messageContent: unknown, compressContent: unknown): string {
  const compressed = decodeMaybeCompressed(compressContent)
  if (compressed) return compressed
  return decodeMaybeCompressed(messageContent)
}

function messageTypeLabel(localType: number): string {
  const labels: Record<number, string> = {
    1: '[文本]',
    3: '[图片]',
    34: '[语音]',
    42: '[名片]',
    43: '[视频]',
    47: '[表情]',
    48: '[位置]',
    49: '[链接]',
    50: '[通话]',
    10000: '[系统消息]'
  }
  return labels[localType] || '[消息]'
}

function cleanSystemMessage(content: string): string {
  const cleaned = String(content || '')
    .replace(/<\?xml[^?]*\?>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\d+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || '[系统消息]'
}

function parseType49(content: string): string {
  const title = extractXmlValue(content, 'title')
  const type = extractXmlValue(content, 'type')

  if (type === '87') {
    const announcement = extractXmlValue(content, 'textannouncement')
    return announcement ? `[群公告] ${announcement}` : '[群公告]'
  }

  if (type === '2000') {
    const fee = extractXmlValue(content, 'feedesc')
    const memo = extractXmlValue(content, 'pay_memo')
    return fee ? `[转账] ${fee}${memo ? ` ${memo}` : ''}` : '[转账]'
  }

  if (type === '2001') {
    const greeting = extractXmlValue(content, 'receivertitle') || extractXmlValue(content, 'sendertitle')
    return greeting ? `[红包] ${greeting}` : '[红包]'
  }

  if (type === '115') {
    const wish = extractXmlValue(content, 'wishmessage')
    const titleText = extractXmlValue(content, 'skutitle')
    return titleText ? `[微信礼物] ${wish || '送你一份心意'} - ${titleText}` : `[微信礼物] ${wish || '送你一份心意'}`
  }

  if (type === '3') {
    const des = extractXmlValue(content, 'des')
    return title ? `[音乐] ${title}${des ? ` - ${des}` : ''}` : '[音乐]'
  }

  if (title) {
    switch (type) {
      case '5':
      case '49':
        return `[链接] ${title}`
      case '6':
        return `[文件] ${title}`
      case '19':
        return `[聊天记录] ${title}`
      case '33':
      case '36':
        return `[小程序] ${title}`
      case '57':
        return title
      default:
        return title
    }
  }

  return '[消息]'
}

export function parseMessageContent(contentInput: string, localType: number): string {
  let content = String(contentInput || '')
  if (!content) return messageTypeLabel(localType)
  content = decodeHtmlEntities(content)
  const xmlType = extractXmlValue(content, 'type')

  switch (localType) {
    case 1:
      return stripSenderPrefix(content)
    case 3:
      return '[图片]'
    case 34:
      return '[语音消息]'
    case 42: {
      const nickname = content.match(/nickname="([^"]*)"/)?.[1]
      return nickname ? `[名片] ${decodeHtmlEntities(nickname)}` : '[名片]'
    }
    case 43:
      return '[视频]'
    case 47:
      return '[动画表情]'
    case 48: {
      const poiname = content.match(/poiname="([^"]*)"/)?.[1]
      const label = content.match(/label="([^"]*)"/)?.[1]
      return poiname ? `[位置] ${decodeHtmlEntities(poiname)}` : label ? `[位置] ${decodeHtmlEntities(label)}` : '[位置]'
    }
    case 49:
      return parseType49(content)
    case 50:
      return '[通话]'
    case 10000:
    case 10002:
      return cleanSystemMessage(content)
    case 244813135921: {
      const title = extractXmlValue(content, 'title')
      return title || '[引用消息]'
    }
    default:
      if (xmlType === '87') {
        const announcement = extractXmlValue(content, 'textannouncement')
        return announcement ? `[群公告] ${announcement}` : '[群公告]'
      }
      if (['2000', '5', '6', '19', '33', '36', '49', '57'].includes(xmlType)) {
        return parseType49(content)
      }
      if (content.length > 200) return messageTypeLabel(localType)
      return stripSenderPrefix(content) || messageTypeLabel(localType)
  }
}

export function parseChatHistory(content: string): AgentChatRecordItem[] | undefined {
  try {
    if (extractXmlValue(content, 'type') !== '19') return undefined
    const match = /<recorditem>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>[\s\S]*?<\/recorditem>/.exec(content)
    if (!match) return undefined

    const items: AgentChatRecordItem[] = []
    const itemRegex = /<dataitem\s+(.*?)>([\s\S]*?)<\/dataitem>/g
    let itemMatch: RegExpExecArray | null
    while ((itemMatch = itemRegex.exec(match[1])) !== null) {
      const datatype = Number(/datatype="(\d+)"/.exec(itemMatch[1])?.[1] || 0)
      const body = itemMatch[2]
      items.push({
        datatype,
        sourcename: extractXmlValue(body, 'sourcename') || undefined,
        sourcetime: extractXmlValue(body, 'sourcetime') || undefined,
        sourceheadurl: extractXmlValue(body, 'sourceheadurl') || undefined,
        datadesc: extractXmlValue(body, 'datadesc') || undefined,
        datatitle: extractXmlValue(body, 'datatitle') || undefined,
        fileext: extractXmlValue(body, 'fileext') || undefined,
        datasize: Number(extractXmlValue(body, 'datasize') || 0) || undefined,
        messageuuid: extractXmlValue(body, 'messageuuid') || undefined,
        dataurl: extractXmlValue(body, 'dataurl') || undefined,
        datathumburl: extractXmlValue(body, 'datathumburl') || extractXmlValue(body, 'thumburl') || undefined,
        datacdnurl: extractXmlValue(body, 'datacdnurl') || extractXmlValue(body, 'cdnurl') || undefined,
        aeskey: extractXmlValue(body, 'aeskey') || extractXmlValue(body, 'qaeskey') || undefined,
        md5: extractXmlValue(body, 'md5') || extractXmlValue(body, 'datamd5') || undefined,
        imgheight: Number(extractXmlValue(body, 'imgheight') || 0) || undefined,
        imgwidth: Number(extractXmlValue(body, 'imgwidth') || 0) || undefined,
        duration: Number(extractXmlValue(body, 'duration') || 0) || undefined
      })
    }
    return items.length > 0 ? items : undefined
  } catch {
    return undefined
  }
}

export function parseFileInfo(content: string): { fileName?: string } {
  if (extractXmlValue(content, 'type') !== '6') return {}
  return { fileName: extractXmlValue(content, 'title') || undefined }
}

export function detectAgentMessageKind(message: Pick<AgentSourceMessage, 'localType' | 'rawContent' | 'parsedContent'>): AgentMessageKind {
  const localType = Number(message.localType || 0)
  const raw = String(message.rawContent || message.parsedContent || '')
  const appType = raw.match(/<type>(\d+)<\/type>/)?.[1]

  if (localType === 1) return 'text'
  if (localType === 3) return 'image'
  if (localType === 34) return 'voice'
  if (localType === 42) return 'contact_card'
  if (localType === 43) return 'video'
  if (localType === 47) return 'emoji'
  if (localType === 48) return 'location'
  if (localType === 50) return 'voip'
  if (localType === 10000 || localType === 10002) return 'system'
  if (localType === 244813135921) return 'quote'

  if (localType === 49 || appType) {
    switch (appType) {
      case '3':
        return 'app_music'
      case '5':
      case '49':
        return 'app_link'
      case '6':
        return 'app_file'
      case '19':
        return 'app_chat_record'
      case '33':
      case '36':
        return 'app_mini_program'
      case '57':
        return 'app_quote'
      case '62':
        return 'app_pat'
      case '87':
        return 'app_announcement'
      case '115':
        return 'app_gift'
      case '2000':
        return 'app_transfer'
      case '2001':
        return 'app_red_packet'
      default:
        return 'app'
    }
  }

  return 'unknown'
}
