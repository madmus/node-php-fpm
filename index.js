const path = require('path')
const fastCgi = require('fastcgi-client')
const defaultOptions = {
  host: '127.0.0.1',
  port: 9000,
  documentRoot: path.dirname(require.main.filename || '.'),
  skipCheckServer: true
}

module.exports = function (userOptions = {}, customParams = {}) {
  const options = Object.assign({}, defaultOptions, userOptions)
  const fpm = new Promise((resolve, reject) => {
    const loader = fastCgi(options)
    loader.on('ready', () => resolve(loader))
    loader.on('error', reject)
  })

  return async function (req, res, next) {
    if (req.url.indexOf('/v2/api') !== -1) {
      return next() // Stop middleware continue NestJS
    }

    let params = Object.assign({}, customParams, {
      uri: req.url
    })

    if (!params.uri || !params.uri.startsWith('/')) {
      throw new Error('invalid uri')
    }

    if (options.rewrite) {
      const rules = Array.isArray(options.rewrite)
        ? options.rewrite : [options.rewrite]
      for (const rule of rules) {
        const match = params.uri.match(rule.search || /.*/)
        if (match) {
          let result = rule.replace
          for (const index in match) {
            const selector = new RegExp(`\\$${index}`, 'g')
            result = result.replace(selector, match[index])
          }
          params.outerUri = params.uri
          params.uri = result
          break
        }
      }
    }

    if (params.uri.indexOf('?') !== -1) {
      params.document = params.uri.split('?')[0]
      params.query = params.uri
        .slice(params.document.length + 1)
        .replace(/\?/g, '&')
    }

    if (!params.script) {
      params.script = path.join(options.documentRoot, params.document || params.uri)
    }

    const headers = {
      REQUEST_METHOD: req.method,
      HTTP_ACCEPT: req.headers['accept'],
      CONTENT_TYPE: req.headers['content-type'],
      CONTENT_LENGTH: req.headers['content-length'],
      CONTENT_DISPOSITION: req.headers['content-disposition'],
      DOCUMENT_ROOT: options.documentRoot,
      SCRIPT_FILENAME: params.script,
      SCRIPT_NAME: params.script.split('/').pop(),
      REQUEST_URI: params.outerUri || params.uri,
      DOCUMENT_URI: params.document || params.uri,
      QUERY_STRING: params.query,
      REQUEST_SCHEME: req.protocol,
      HTTPS: req.protocol === 'https' ? 'on' : undefined,
      REMOTE_ADDR: req.connection.remoteAddress,
      REMOTE_PORT: req.connection.remotePort,
      SERVER_NAME: req.connection.domain,
      HTTP_HOST: req.headers.host,
      HTTP_COOKIE: req.headers.cookie,
      SERVER_PROTOCOL: 'HTTP/1.1',
      GATEWAY_INTERFACE: 'CGI/1.1',
      SERVER_SOFTWARE: 'php-fpm for Node',
      REDIRECT_STATUS: 200,
      SERVER_PORT: req.headers.host.split(':')[1] || 80,
      SERVER_NAME: req.headers.host.split(':')[0] || '127.0.0.1',
    }
    
    if (req.headers['x-widget-csrf-token'] !== undefined) {
      headers['HTTP_X_WIDGET_CSRF_TOKEN'] = req.headers['x-widget-csrf-token'];
    }

    if (req.headers['x-requested-with'] !== undefined) {
      headers['HTTP_X_REQUESTED_WITH'] = req.headers['x-requested-with']
    }

    for (const header in headers) {
      if (typeof headers[header] === 'undefined') { delete headers[header] }
    }

    if (options.debug) {
      console.log(headers)
    }

    const php = await fpm
    return new Promise(function (resolve, reject) {
      php.request(headers, function (err, request) {
        if (err) { reject(err) }
        var output = ''
        var errors = ''

        req.pipe(request.stdin)

        request.stdout.on('data', function (data) {
          output += data.toString('utf8')
        })

        request.stderr.on('data', function (data) {
          errors += data.toString('utf8')
        })

        request.stdout.on('end', function () {
          if (errors) { reject(new Error(errors)) }

          const head = output.match(/^[\s\S]*?\r\n\r\n/)[0]

          const parseHead = head.split('\r\n').filter(_ => _)
          const cookies = parseHead.filter(
            value => value.split(':')[0] === 'Set-Cookie'
          ).map(
            value => value.split(':')[1].split(';')[0].trim()
          )

          let headers = {}
          for (const item of parseHead) {
            const pair = item.split(': ')
            if (pair[0] !== 'Set-Cookie') {
              res.setHeader(pair[0], pair[1])
            }
            if (pair[0] === 'Status') {
              res.statusCode = parseInt(pair[1].match(/\d+/)[0])
            }
          }
          res.setHeader('Set-Cookie', cookies)
          const body = output.slice(head.length)
          res.write(body)
          res.end()

          resolve({ headers, body })
        })
      })
    })
  }
}
