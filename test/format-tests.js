const should = require('should');
const check = require('validator').check;

describe('convict formats', function() {
  const convict = require('../');
  var conf;

  it('should parse a config specification', function() {
    conf = convict({
      foo: {
        enum: {
          format: ['foo', 'bar'],
          default: 'foo'
        },
        date: {
          format: 'timestamp',
          default: 'May 5, 2013'
        },
        duration: {
          format: 'duration',
          default: '5 minutes'
        },
        host: {
          format: 'ipaddress',
          default: '127.0.0.1'
        },
        port: {
          format: 'port',
          default: 8080
        },
        email: {
          format: 'email',
          default: 'foo@bar.com'
        },
        url: {
          format: 'url',
          default: 'http://example.com'
        },
        nat: {
          format: 'nat',
          default: 42
        },
        int: {
          format: 'int',
          default: -9
        },
        any: {
          format: '*',
          default: "foo"
        },
        custom: {
          format: function (val) {
            check(val, 'expected alpha characters, got ' + val).isAlpha();
          },
          default: 'abcd'
        }
      }
    });
  });

  it('should be valid', function() {
    (function() { conf.validate() }).should.not.throw();
  });

  describe('predefined formats', function() {
    it('should handle timestamp', function() {
      var val = conf.get('foo.date');
      should.equal(val, 1367737200000);
    });

    it('should handle duration', function() {
      should.equal(conf.get('foo.duration'), 60 * 5 * 1000);
    });
  });
});
