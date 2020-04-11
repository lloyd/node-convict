'use strict'

const expect = require('must')

describe('convict formats', function() {
  const convict = require('../')
  let conf

  it('must parse a config specification', function() {

    convict.addFormat({
      name: 'float-percent',
      validate: function(val) {
        if (val !== 0 && (!val || val > 1 || val < 0)) {
          throw new Error('must be a float between 0 and 1, inclusive')
        }
      },
      coerce: function(val) {
        return parseFloat(val, 10)
      }
    })

    convict.addFormats({
      prime: {
        validate: function(val) {
          function isPrime(n) {
            if (n <= 1) {
              return false
            } // zero and one are not prime
            for (let i = 2; i * i <= n; i++) {
              if (n % i === 0) {
                return false
              }
            }
            return true
          }
          if (!isPrime(val)) {
            throw new Error('must be a prime number')
          }
        },
        coerce: function(val) {
          return parseInt(val, 10)
        }
      },
      'hex-string': {
        validate: function(val) {
          if (/^[0-9a-fA-F]+$/.test(val)) {
            throw new Error('must be a hexidecimal string')
          }
        }
      }
    })

    conf = convict({
      foo: {
        enum: {
          format: ['foo', 'bar'],
          default: 'foo'
        },
        port: {
          format: 'port',
          default: 8080
        },
        pipe: {
          format: 'windows_named_pipe',
          default: '\\\\.\\pipe\\test',
        },
        pipe_port: {
          format: 'port_or_windows_named_pipe',
          default: '\\\\.\\pipe\\pipe_port',
        },
        nat: {
          format: 'nat',
          default: 42
        },
        int: {
          format: 'int',
          default: -9
        },
        int2: {
          format: 'integer',
          default: 42
        },
        any: {
          format: '*',
          default: 'foo'
        },
        primeNumber: {
          format: 'prime',
          default: 17
        },
        percentNumber: {
          format: 'float-percent',
          default: 0.5
        },
        optional: {
          format: '*',
          default: undefined
        }
      }
    })

  })

  it('validates default schema', function() {
    (function() {
      conf.validate()
    }).must.not.throw()
  })

  it('validates non-coerced correct values', function() {
    conf.set('foo.primeNumber', 7);
    (function() {
      conf.validate()
    }).must.not.throw()
  })

  it('validates coerced correct values', function() {
    conf.set('foo.primeNumber', '11');
    (function() {
      conf.validate()
    }).must.not.throw()
  })

  it('successfully fails to validate incorrect values', function() {
    conf.set('foo.primeNumber', 16);
    (function() {
      conf.validate()
    }).must.throw()
  })

  describe('predefined formats', function() {
    describe('port_or_windows_named_pipe', function() {
      const conf = convict({
        port: {
          format: 'port_or_windows_named_pipe',
          default: '1234',
        },
        pipe: {
          format: 'port_or_windows_named_pipe',
          default: '\\\\.\\pipe\\test',
        },
        to_pipe: {
          format: 'port_or_windows_named_pipe',
          default: 1234,
        },
        to_port: {
          format: 'port_or_windows_named_pipe',
          default: '\\\\.\\pipe\\default',
        },
      })

      it('must coerce ports to integers', function() {
        conf.get('port').must.be(1234)
      })

      it('must not coerce pipes to integers', function() {
        conf.get('pipe').must.be('\\\\.\\pipe\\test')
      })

      it('must handle switching from port to pipe', function() {
        conf.set('to_pipe', '\\\\.\\pipe\\changed')
        conf.get('to_pipe').must.be('\\\\.\\pipe\\changed')
      })

      it('must handle switching from pipe to port', function() {
        conf.set('to_port', '8080')
        conf.get('to_port').must.be(8080)
      })

      it('must throw for invalid ports', function() {
        const conf = convict({
          invalid: {
            format: 'port_or_windows_named_pipe',
            default: '235235452355',
          },
        });

        (function() {
          conf.validate()
        }).must.throw(Error, /must be a windows named pipe or a number within range/)
      })

      it('must throw for invalid pipes', function() {

        const conf = convict({
          invalid: {
            format: 'port_or_windows_named_pipe',
            default: '\\.pipe\\test',
          },
        });

        (function() {
          conf.validate()
        }).must.throw(Error, /must be a windows named pipe or a number within range/)
      })
    })
  })

  it('must throw with unknown format', function() {
    (function() {
      convict({
        foo: {
          format: 'unknown',
          default: 'bar'
        }
      })
    }).must.throw()
  })

  it('must accept undefined as a default', function() {
    const val = conf.get('foo.optional')
    expect(val).to.be(undefined)
  })

  describe('must return schema in second argument', function() {
    const schema = {
      domains: {
        doc: 'A collection of domain names.',
        format: 'source-array',
        default: [],

        children: {
          domain_base: {
            doc: 'The base domain name',
            format: 'String',
            default: null
          },
          extension: {
            doc: 'The domain name extension',
            format: ['org', 'net', 'com'],
            default: null
          },
          bought: {
            doc: 'Whether the domain has been bought or not',
            format: 'Boolean',
            default: null
          },
        }
      }
    }

    const configWithoutErrors = {
      domains: [
        {
          domain_base: 'mozilla',
          extension: 'org',
          bought: true,
        },
        {
          domain_base: 'gitlab',
          extension: 'com',
          bought: true,
        }
      ]
    }

    const configWithErrors = {
      domains: [
        {
          domain_base: 'mozilla',
          extension: 'org',
          bought: true,
        },
        {
          domain_base: 'gitlab',
          extension: 'com',
          bought: 8,
        }
      ]
    }

    it('must parse a config specification', function() {
      convict.addFormat({
        name: 'source-array',
        validate: function(sources, schema) {
          if (!Array.isArray(sources)) {
            throw new Error('must be of type Array')
          }

          sources.forEach((source) => {
            convict(schema.children).load(source).validate()
          })
        }
      })
    })

    it('must validate children value without throw an Error', function() {
      (function() {
        convict(schema).load(configWithoutErrors).validate()
      }).must.not.throw()
    })

    it('successfully fails to validate incorrect children values', function() {
      (function() {
        convict(schema).load(configWithErrors).validate()
      }).must.throw(Error, /domains: bought: must be of type Boolean/)
    })
  })
})
