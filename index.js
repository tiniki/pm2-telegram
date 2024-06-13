const pm2 = require('pm2')
const pmx = require('pmx')
const util = require('util')
const fastq = require('fastq')
const https = require('https')

let moduleConfig
const configByProcessName = {}
/**
 * @param {string} processName
 * @returns {{ botToken: string, chatId: string, messageThreadId: string | null}}
 */
function getConfigByProcessName(processName) {
  if (configByProcessName[processName] === undefined) {
    const botToken = moduleConfig[`telegram_bot_token-${processName}`] || moduleConfig.telegram_bot_token
    const chatId = moduleConfig[`telegram_chat_id-${processName}`] || moduleConfig.telegram_chat_id
    configByProcessName[processName] = !botToken || !chatId ? null : {
      botToken,
      chatId: chatId.replace(/^g/, ''),
      messageThreadId: moduleConfig[`telegram_message_thread_id-${processName}`] || moduleConfig.telegram_message_thread_id,
    }
  }
  return configByProcessName[processName]
}

function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&')
}

function escapeMarkdownCode(text) {
  return text.replace(/[`\\]/g, '\\$&')
}

/**
 * @param {{ name: string, text: string }} data
 */
function sendMessage(data) {
  const config = getConfigByProcessName(data.name)
  if (!config) return Promise.resolve()
  const content = data.text.length < 3000 ? data.text : data.text.substring(0, 3000)
  const text = `*${escapeMarkdown(data.name)}*\n\n\`\`\`\n${escapeMarkdownCode(content)}\`\`\``
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      chat_id: config.chatId,
      text,
      parse_mode: 'MarkdownV2',
      ...(config.messageThreadId ? { message_thread_id: config.messageThreadId } : {}),
    })
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${config.botToken}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      const responseBody = []
      res.setEncoding('utf8')

      res.on('data', (chunk) => {
        responseBody.push(chunk)
      })

      res.on('end', () => {
        try {
          if (res.statusCode >= 200 && res.statusCode <= 299) {
            resolve(responseBody.join())
          } else {
            reject(new Error(`Status: ${res.statusCode}\n${responseBody.join()}`))
          }
        } catch (e) {
          reject(e)
        }
      })
    })

    req.on('error', (e) => {
      reject(e)
    })

    req.write(postData)
    req.end()
  }).catch((e) => console.error(e))
}

async function main() {
  moduleConfig = await util.promisify(pmx.initModule)({})
  const bus = await util.promisify(pm2.launchBus).bind(pm2)()
  const {
    module_name: moduleName,
    auto_event_only: autoEventOnly,
  } = moduleConfig

  const queue = fastq.promise(sendMessage, 1)
  const queueLimit = moduleConfig.queue_limit

  if (moduleConfig.log) {
    bus.on('log:out', (data) => {
      if (data.process.name === moduleName || queue.length() > queueLimit) return

      queue.push({
        name: data.process.name,
        text: data.data,
      })
    })
  }

  if (moduleConfig.error) {
    bus.on('log:err', (data) => {
      if (data.process.name === moduleName || queue.length() > queueLimit) return

      queue.push({
        name: data.process.name,
        text: data.data,
      })
    })
  }

  if (moduleConfig.kill) {
    bus.on('pm2:kill', (data) => {
      queue.push({
        name: data.process.name,
        text: data.msg,
      })
    })
  }

  if (moduleConfig.exception) {
    bus.on('process:exception', (data) => {
      if (data.process.name === moduleName) return

      const text = (data.data?.message) ? data.data.message : JSON.stringify(data.data)
      queue.push({
        name: data.process.name,
        text,
      })
    })
  }

  bus.on('process:event', (data) => {
    if (!moduleConfig[data.event]) return
    if (autoEventOnly && data.manually) return
    if (data.process.name === moduleName) return

    queue.push({
      name: data.process.name,
      text: `${data.event} event occurred`,
    })
  })

  return new Promise(() => {})
}

main().then(process.exit).catch((e) => {
  console.error(e)
  process.exit(1)
})
