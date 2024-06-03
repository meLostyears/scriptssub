async function operator(proxies = [], targetPlatform, env) {
  const $ = $substore
  const { isLoon, isSurge } = $.env
  if (!isLoon && !isSurge) throw new Error('仅支持 Loon 和 Surge(ability=http-client-policy)')
  const telegram_chat_id = $arguments.telegram_chat_id
  const telegram_bot_token = $arguments.telegram_bot_token
  const cacheEnabled = $arguments.cache
  const cache = scriptResourceCache
  const method = $arguments.method || 'head'
  const keepIncompatible = $arguments.keep_incompatible
  const validStatus = parseInt($arguments.status || 200)
  const url = decodeURIComponent($arguments.url || 'http://www.apple.com/library/test/success.html')
  const target = isLoon ? 'Loon' : isSurge ? 'Surge' : undefined
  const validProxies = []
  const incompatibleProxies = []
  const failedProxies = []
  const sub = env.source[proxies?.[0]?.subName]
  const subName = sub?.displayName || sub?.name

  const concurrency = parseInt($arguments.concurrency || 10) // 一组并发数
  await executeAsyncTasks(
    proxies.map(proxy => () => check(proxy)),
    { concurrency }
  )

  if (telegram_chat_id && telegram_bot_token && failedProxies.length > 0) {
    const text = `\`${subName}\` 节点测试:\n${failedProxies
      .map(proxy => `❌ [${proxy.type}] \`${proxy.name}\``)
      .join('\n')}`
    await http({
      method: 'post',
      url: `https://api.telegram.org/bot${telegram_bot_token}/sendMessage`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ chat_id: telegram_chat_id, text, parse_mode: 'MarkdownV2' }),
    })
  }

  return validProxies

  async function check(proxy) {
    const id = cacheEnabled
      ? `availability:${url}:${method}:${validStatus}:${JSON.stringify(
          Object.fromEntries(
            Object.entries(proxy).filter(([key]) => !/^(name|collectionName|subName|id|_.*)$/i.test(key))
          )
        )}`
      : undefined
    try {
      const node = ProxyUtils.produce([proxy], target)
      if (node) {
        const cached = cache.get(id)
        if (cacheEnabled && cached) {
          $.info(`[${proxy.name}] 使用缓存`)
          if (cached.latency) {
            validProxies.push({
              ...proxy,
              name: `${$arguments.show_latency ? `[${cached.latency}] ` : ''}${proxy.name}`,
            })
          }
          return
        }
        const startedAt = Date.now()
        const res = await http({
          method,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
          },
          url,
          'policy-descriptor': node,
          node,
        })
        const status = parseInt(res.status || res.statusCode || 200)
        let latency = `${Date.now() - startedAt}`.padStart(4, '0')
        $.info(`[${proxy.name}] status: ${status}, latency: ${latency}`)
        if (status == validStatus) {
          validProxies.push({
            ...proxy,
            name: `${$arguments.show_latency ? `[${latency}] ` : ''}${proxy.name}`,
          })
          if (cacheEnabled) {
            $.info(`[${proxy.name}] 设置成功缓存`)
            cache.set(id, { latency })
          }
        } else {
          if (cacheEnabled) {
            $.info(`[${proxy.name}] 设置失败缓存`)
            cache.set(id, {})
          }
          failedProxies.push(proxy)
        }
      } else {
        if (keepIncompatible) {
          validProxies.push(proxy)
        }
        incompatibleProxies.push(proxy)
      }
    } catch (e) {
      $.error(`[${proxy.name}] ${e.message ?? e}`)
      if (cacheEnabled) {
        $.info(`[${proxy.name}] 设置失败缓存`)
        cache.set(id, {})
      }
      failedProxies.push(proxy)
    }
  }

  async function http(opt = {}) {
    const METHOD = opt.method || 'get'
    const TIMEOUT = parseFloat(opt.timeout || $arguments.timeout || 5000)
    const RETRIES = parseFloat(opt.retries ?? $arguments.retries ?? 1)
    const RETRY_DELAY = parseFloat(opt.retry_delay ?? $arguments.retry_delay ?? 1000)

    let count = 0
    const fn = async () => {
      try {
        return await $.http[METHOD]({ ...opt, timeout: TIMEOUT })
      } catch (e) {
        if (count < RETRIES) {
          count++
          const delay = RETRY_DELAY * count
          await $.wait(delay)
          return await fn()
        } else {
          throw e
        }
      }
    }
    return await fn()
  }

  function executeAsyncTasks(tasks, { wrap, result, concurrency = 1 } = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        let running = 0
        const results = []

        let index = 0

        function executeNextTask() {
          while (index < tasks.length && running < concurrency) {
            const taskIndex = index++
            const currentTask = tasks[taskIndex]
            running++

            currentTask()
              .then(data => {
                if (result) {
                  results[taskIndex] = wrap ? { data } : data
                }
              })
              .catch(error => {
                if (result) {
                  results[taskIndex] = wrap ? { error } : error
                }
              })
              .finally(() => {
                running--
                executeNextTask()
              })
          }

          if (running === 0) {
            return resolve(result ? results : undefined)
          }
        }

        await executeNextTask()
      } catch (e) {
        reject(e)
      }
    })
  }
}
