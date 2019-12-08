/**
 * convict
 * Configuration management with support for environmental variables, files,
 * and validation.
 */
'use strict';

const fs        = require('fs');
const parseArgs = require('yargs-parser');
const cloneDeep = require('lodash.clonedeep');

function assert(assertion, err_msg) {
  if (!assertion) {
    throw new Error(err_msg);
  }
}

// format can be a:
// - predefine type, as seen below
// - an array of enumerated values, e.g. ["production", "development", "testing"]
// - built-in JavaScript type, i.e. Object, Array, String, Number, Boolean, RegExp
// - or if omitted, the Object.prototype.toString.call of the default value

/**
 * Checks if x is a valid port
 *
 * @param {*} x
 * @returns {Boolean}
 */
function isPort(x) {
  return Number.isInteger(x) && x >= 0 && x <= 65535;
}

/**
 * Checks if x is a windows named pipe
 *
 * @see https://msdn.microsoft.com/en-us/library/windows/desktop/aa365783(v=vs.85).aspx
 * @param {*} x
 * @returns {Boolean}
 */
function isWindowsNamedPipe(x) {
  return String(x).includes('\\\\.\\pipe\\');
}

const types = {
  '*': function() { },
  int: function(x) {
    assert(Number.isInteger(x), 'must be an integer');
  },
  nat: function(x) {
    assert(Number.isInteger(x) && x >= 0, 'must be a positive integer');
  },
  port: function(x) {
    assert(isPort(x), 'ports must be within range 0 - 65535');
  },
  windows_named_pipe: function(x) {
    assert(isWindowsNamedPipe(x), 'must be a valid pipe');
  },
  port_or_windows_named_pipe: function(x) {
    if (!isWindowsNamedPipe(x)) {
      assert(isPort(x), 'must be a windows named pipe or a number within range 0 - 65535');
    }
  }
};
// alias
types.integer = types.int;

const converters = new Map();

const parsers_registry = { '*': JSON.parse };

const ALLOWED_OPTION_STRICT = 'strict';
const ALLOWED_OPTION_WARN = 'warn';

function flatten(obj, useProperties) {
  let stack = Object.keys(obj);
  let key;

  let entries = [];

  while (stack.length) {
    key = stack.shift();
    let val = walk(obj, key);
    if (typeof val === 'object' && !Array.isArray(val) && val != null) {
      if (useProperties) {
        if ('properties' in val) {
          val = val.properties;
          key = key + '.properties';
        } else {
          entries.push([key, val]);
          continue;
        }
      }
      let subkeys = Object.keys(val);

      // Don't filter out empty objects
      if (subkeys.length > 0) {
        subkeys.forEach(function(subkey) {
          stack.push(key + '.' + subkey);
        });
        continue;
      }
    }
    entries.push([key, val]);
  }

  let flattened = {};
  entries.forEach(function(entry) {
    let key = entry[0];
    if (useProperties) {
      key = key.replace(/\.properties/g, '');
    }
    const val = entry[1];
    flattened[key] = val;
  });

  return flattened;
}

function validate(instance, schema, strictValidation) {
  let errors = {
    undeclared: [],
    invalid_type: [],
    missing: []
  };

  const flatInstance = flatten(instance);
  const flatSchema = flatten(schema.properties, true);

  Object.keys(flatSchema).forEach(function(name) {
    const schemaItem = flatSchema[name];
    let instanceItem = flatInstance[name];
    if (!(name in flatInstance)) {
      try {
        if (typeof schemaItem.default === 'object' &&
          !Array.isArray(schemaItem.default)) {
          // Missing item may be an object with undeclared children, so try to
          // pull it unflattened from the config instance for type validation
          instanceItem = walk(instance, name);
        } else {
          throw new Error('missing');
        }
      } catch (e) {
        const err = new Error("configuration param '" + name
          + "' missing from config, did you override its parent?");
        errors.missing.push(err);
        return;
      }
    }
    delete flatInstance[name];

    // ignore nested keys of schema 'object' properties
    if (schemaItem.format === 'object' || typeof schemaItem.default === 'object') {
      Object.keys(flatInstance)
        .filter(function(key) {
          return key.lastIndexOf(name + '.', 0) === 0;
        }).forEach(function(key) {
          delete flatInstance[key];
        });
    }

    if (!(typeof schemaItem.default === 'undefined' &&
          instanceItem === schemaItem.default)) {
      try {
        schemaItem._format(instanceItem);
      } catch (err) {
        errors.invalid_type.push(err);
      }
    }

    return;
  });

  if (strictValidation) {
    Object.keys(flatInstance).forEach(function(name) {
      const err = new Error("configuration param '" + name
        + "' not declared in the schema");
      errors.undeclared.push(err);
    });
  }

  return errors;
}

// helper for asserting that a value is in the list of valid options
function contains(options, x) {
  assert(options.indexOf(x) !== -1, 'must be one of the possible values: ' +
         JSON.stringify(options));
}

const BUILT_INS_BY_NAME = {
  'Object': Object,
  'Array': Array,
  'String': String,
  'Number': Number,
  'Boolean': Boolean,
  'RegExp': RegExp
};
const BUILT_IN_NAMES = Object.keys(BUILT_INS_BY_NAME);
const BUILT_INS = BUILT_IN_NAMES.map(function(name) {
  return BUILT_INS_BY_NAME[name];
});

function normalizeSchema(name, rawSchema, props, fullName, env, argv, sensitive) {
  // If the current schema rawSchema is not a config property (has no "default"), recursively normalize it.
  if (typeof rawSchema === 'object' && rawSchema !== null && !Array.isArray(rawSchema) &&
        Object.keys(rawSchema).length > 0 && !('default' in rawSchema)) {
    props[name] = {
      properties: {}
    };
    Object.keys(rawSchema).forEach(function(key) {
      const path = fullName + '.' + key;
      normalizeSchema(key, rawSchema[key], props[name].properties, path, env, argv, sensitive);
    });
    return;
  } else if (typeof rawSchema !== 'object' || Array.isArray(rawSchema) ||
    rawSchema === null || Object.keys(rawSchema).length == 0) {
    // Normalize shorthand "value" config properties
    rawSchema = { default: rawSchema };
  }

  const schema = cloneDeep(rawSchema);
  props[name] = schema;
  // associate this property with an environmental variable
  if (schema.env) {
    if (!env[schema.env]) {
      env[schema.env] = [];
    }
    env[schema.env].push(fullName);
  }

  // associate this property with a command-line argument
  if (schema.arg) {
    if (argv[schema.arg]) {
      throw new Error("'" + fullName + "' reuses a command-line argument: " + schema.arg);
    }
    argv[schema.arg] = fullName;
  }

  // mark this property as sensitive
  if (schema.sensitive === true) {
    sensitive.add(fullName);
  }

  // store original format function
  const format = schema.format;
  let newFormat = (() => {
    if (BUILT_INS.indexOf(format) >= 0 || BUILT_IN_NAMES.indexOf(format) >= 0) {
      // if the format property is a built-in JavaScript constructor,
      // assert that the value is of that type
      const Format = typeof format === 'string' ? BUILT_INS_BY_NAME[format] : format;
      const formatFormat = Object.prototype.toString.call(new Format());
      const myFormat = Format.name;
      schema.format = myFormat.toLowerCase();
      return function(value) {
        const valueFormat = Object.prototype.toString.call(value);
        assert(valueFormat === formatFormat, 'must be of type ' + myFormat);
      };
    } else if (typeof format === 'string') {
      // store declared type
      if (!types[format]) {
        throw new Error("'" + fullName + "' uses an unknown format type: " + format);
      }
      // use a predefined type
      return types[format];
    } else if (Array.isArray(format)) {
      // assert that the value is a valid option
      return contains.bind(null, format);
    } else if (typeof format === 'function') {
      return format;
    } else if (format && typeof format !== 'function') {
      throw new Error("'" + fullName +
        "': `format` must be a function or a known format type.");
    } else { // !format
      // default format is the typeof the default value
      const defaultFormat = Object.prototype.toString.call(schema.default);
      const myFormat = defaultFormat.replace(/\[.* |]/g, '');
      // magic coerceing
      schema.format = myFormat.toLowerCase();
      return function(value) {
        const valueFormat = Object.prototype.toString.call(value);
        assert(valueFormat === defaultFormat, 'must be of type ' + myFormat);
      };
    }
  })();

  schema._format = function(x) {
    try {
      newFormat(x, schema); // schema = this
    } catch (e) {
      // attach the value and the property's fullName to the error
      e.fullName = fullName;
      e.value = x;
      throw e;
    }
  };
}

function importEnvironment(o) {
  const env = o.getEnv();
  Object.keys(o._env).forEach(function(envStr) {
    if (env[envStr] !== undefined) {
      let ks = o._env[envStr];
      ks.forEach(function(k) {
        o.set(k, env[envStr]);
      });
    }
  });
}

function importArguments(o) {
  const argv = parseArgs(o.getArgs(), {
    configuration: {
      'dot-notation': false
    }
  });
  Object.keys(o._argv).forEach(function(argStr) {
    let k = o._argv[argStr];
    if (argv[argStr] !== undefined) {
      o.set(k, String(argv[argStr]));
    }
  });
}

function addDefaultValues(schema, node) {
  Object.keys(schema.properties).forEach(function(name) {
    const mySchema = schema.properties[name];
    if (mySchema.properties) {
      node[name] = {}; // node[name] is always undefined because addDefaultValues is the first to run.
      addDefaultValues(mySchema, node[name]);
    } else {
      node[name] = coerce(mySchema, cloneDeep(mySchema.default));
    }
  });
}

function isObj(o) { return (typeof o === 'object' && o !== null); }

function overlay(from, to, schema) {
  Object.keys(from).forEach(function(name) {
    const mySchema = (schema && schema.properties) ? schema.properties[name] : null;
    // leaf
    if (Array.isArray(from[name]) || !isObj(from[name]) || !schema || schema.format === 'object') {
      to[name] = coerce(mySchema, from[name]);
    } else {
      if (!isObj(to[name])) to[name] = {};
      overlay(from[name], to[name], mySchema);
    }
  });
}

function traverseSchema(schema, path) {
  let ar = path.split('.');
  let o = schema;
  while (ar.length > 0) {
    let k = ar.shift();
    if (o && o.properties && o.properties[k]) {
      o = o.properties[k];
    } else {
      o = null;
      break;
    }
  }

  return o;
}

function coerce(schema, v) {
  const format = (schema && typeof schema.format === 'string') ? schema.format : null;

  if (typeof v === 'string') {
    if (converters.has(format)) {
      return converters.get(format)(v);
    }
    switch (format) {
    case 'port':
    case 'nat':
    case 'integer':
    case 'int': return parseInt(v, 10);
    case 'port_or_windows_named_pipe': return isWindowsNamedPipe(v) ? v : parseInt(v, 10);
    case 'number': return parseFloat(v);
    case 'boolean': return (String(v).toLowerCase() !== 'false');
    case 'array': return v.split(',');
    case 'object': return JSON.parse(v);
    case 'regexp': return new RegExp(v);
    default:
      // ?
    }

    // TODO: Should we throw an exception here?
  }

  return v;
}

function loadFile(path) {
  const segments = path.split('.');
  const extension = segments.length > 1 ? segments.pop() : '';
  const parse = parsers_registry[extension] || parsers_registry['*'];

  // TODO Get rid of the sync call
  // eslint-disable-next-line no-sync
  return parse(fs.readFileSync(path, 'utf-8'));
}

function walk(obj, path, initializeMissing) {
  if (path) {
    let ar = path.split('.');
    while (ar.length) {
      let k = ar.shift();
      if (initializeMissing && obj[k] == null) {
        obj[k] = {};
        obj = obj[k];
      } else if (k in obj) {
        obj = obj[k];
      } else {
        throw new Error("cannot find configuration param '" + path + "'");
      }
    }
  }

  return obj;
}

/**
 * @returns a config object
 */
let convict = function convict(def, opts) {

  // TODO: Rename this `rv` variable (supposedly "return value") into something
  // more meaningful.
  let rv = {
    /**
     * Gets the array of process arguments, using the override passed to the
     * convict function or process.argv if no override was passed.
     */
    getArgs: function() {
      return (opts && opts.args) || process.argv.slice(2);
    },

    /**
     * Gets the environment variable map, using the override passed to the
     * convict function or process.env if no override was passed.
     */
    getEnv: function() {
      return (opts && opts.env) || process.env;
    },

    /**
     * Exports all the properties (that is the keys and their current values) as JSON
     */
    getProperties: function() {
      return cloneDeep(this._instance);
    },

    /**
     * Exports all the properties (that is the keys and their current values) as
     * a JSON string, with sensitive values masked. Sensitive values are masked
     * even if they aren't set, to avoid revealing any information.
     */
    toString: function() {
      let clone = cloneDeep(this._instance);
      this._sensitive.forEach(function(key) {
        let path = key.split('.');
        let childKey = path.pop();
        let parentKey = path.join('.');
        let parent = walk(clone, parentKey);
        parent[childKey] = '[Sensitive]';
      });
      return JSON.stringify(clone, null, 2);
    },

    /**
     * Exports the schema as JSON.
     */
    getSchema: function() {
      return JSON.parse(JSON.stringify(this._schema));
    },

    /**
     * Exports the schema as a JSON string
     */
    getSchemaString: function() {
      return JSON.stringify(this._schema, null, 2);
    },

    /**
     * @returns the current value of the name property. name can use dot
     *     notation to reference nested values
     */
    get: function(path) {
      let o = walk(this._instance, path);
      return cloneDeep(o);
    },

    /**
     * @returns the default value of the name property. name can use dot
     *     notation to reference nested values
     */
    default: function(path) {
      // The default value for FOO.BAR.BAZ is stored in `_schema.properties` at:
      //   FOO.properties.BAR.properties.BAZ.default
      path = (path.split('.').join('.properties.')) + '.default';
      let o = walk(this._schema.properties, path);
      return cloneDeep(o);
    },

    /**
     * Resets a property to its default value as defined in the schema
     */
    reset: function(prop_name) {
      this.set(prop_name, this.default(prop_name));
    },

    /**
     * @returns true if the property name is defined, or false otherwise
     */
    has: function(path) {
      try {
        let r = this.get(path);
        // values that are set but undefined return false
        return typeof r !== 'undefined';
      } catch (e) {
        return false;
      }
    },

    /**
     * Sets the value of name to value. name can use dot notation to reference
     * nested values, e.g. "database.port". If objects in the chain don't yet
     * exist, they will be initialized to empty objects
     */
    set: function(k, v) {
      v = coerce(traverseSchema(this._schema, k), v);
      let path = k.split('.');
      let childKey = path.pop();
      let parentKey = path.join('.');
      let parent = walk(this._instance, parentKey, true);
      parent[childKey] = v;
      return this;
    },

    /**
     * Loads and merges a JavaScript object into config
     */
    load: function(conf) {
      overlay(conf, this._instance, this._schema);
      // environment and arguments always overrides config files
      importEnvironment(rv);
      importArguments(rv);
      return this;
    },

    /**
     * Loads and merges one or multiple JSON configuration files into config
     */
    loadFile: function(paths) {
      let self = this;
      if (!Array.isArray(paths)) paths = [paths];
      paths.forEach(function(path) {
        // Support empty config files #253
        const result = loadFile(path);
        if (result) {
          overlay(result, self._instance, self._schema);
        }
      });
      // environment and arguments always overrides config files
      importEnvironment(rv);
      importArguments(rv);
      return this;
    },

    /**
     * Validates config against the schema used to initialize it
     */
    validate: function(options) {
      options = options || {};

      options.allowed = options.allowed || ALLOWED_OPTION_WARN;

      if (options.output && typeof options.output !== 'function') {
        throw new Error('options.output is optionnal and must be a function.');
      }

      const output_function = options.output || global.console.log;

      let errors = validate(this._instance, this._schema, options.allowed);

      if (errors.invalid_type.length + errors.undeclared.length + errors.missing.length) {
        let sensitive = this._sensitive;

        let fillErrorBuffer = function(errors) {
          let err_buf = '';
          for (let i = 0; i < errors.length; i++) {

            if (err_buf.length) err_buf += '\n';

            let e = errors[i];

            if (e.fullName) {
              err_buf += e.fullName + ': ';
            }
            if (e.message) err_buf += e.message;
            if (e.value && !sensitive.has(e.fullName)) {
              err_buf +=  ': value was ' + JSON.stringify(e.value);
            }
          }
          return err_buf;
        };

        const types_err_buf = fillErrorBuffer(errors.invalid_type);
        const params_err_buf = fillErrorBuffer(errors.undeclared);
        const missing_err_buf = fillErrorBuffer(errors.missing);

        let output_err_bufs = [types_err_buf, missing_err_buf];

        if (options.allowed === ALLOWED_OPTION_WARN && params_err_buf.length) {
          let warning = 'Warning:';
          if (process.stdout.isTTY) {
            // Write 'Warning:' in bold and in yellow
            const SET_BOLD_YELLOW_TEXT = '\x1b[33;1m';
            const RESET_ALL_ATTRIBUTES = '\x1b[0m';
            warning = SET_BOLD_YELLOW_TEXT + warning + RESET_ALL_ATTRIBUTES;
          }
          output_function(warning + ' ' + params_err_buf);
        } else if (options.allowed === ALLOWED_OPTION_STRICT) {
          output_err_bufs.push(params_err_buf);
        }

        let output = output_err_bufs
          .filter(function(str) { return str.length; })
          .join('\n');

        if(output.length) {
          throw new Error(output);
        }

      }
      return this;
    }
  };

  // If the definition is a string treat it as an external schema file
  if (typeof def === 'string') {
    rv._def = loadFile(def);
  } else {
    rv._def = def;
  }

  // build up current config from definition
  rv._schema = {
    properties: {}
  };

  rv._env = {};
  rv._argv = {};
  rv._sensitive = new Set();

  Object.keys(rv._def).forEach(function(k) {
    normalizeSchema(k, rv._def[k], rv._schema.properties, k, rv._env, rv._argv,
      rv._sensitive);
  });

  rv._instance = {};
  addDefaultValues(rv._schema, rv._instance);
  importEnvironment(rv);
  importArguments(rv);

  return rv;
};

/**
 * Adds a new custom format
 */
convict.addFormat = function(name, validate, coerce) {
  if (typeof name === 'object') {
    validate = name.validate;
    coerce = name.coerce;
    name = name.name;
  }
  if (typeof validate !== 'function') {
    throw new Error('Validation function for ' + name + ' must be a function.');
  }
  if (coerce && typeof coerce !== 'function') {
    throw new Error('Coerce function for ' + name + ' must be a function.');
  }
  types[name] = validate;
  if (coerce) converters.set(name, coerce);
};

/**
 * Adds new custom formats
 */
convict.addFormats = function(formats) {
  Object.keys(formats).forEach(function(name) {
    convict.addFormat(name, formats[name].validate, formats[name].coerce);
  });
};

/**
 * Adds a new custom file parser
 */
convict.addParser = function(parsers) {
  if (!Array.isArray(parsers)) parsers = [parsers];

  parsers.forEach(function(parser) {
    if (!parser) throw new Error('Invalid parser');
    if (!parser.extension) throw new Error('Missing parser.extension');
    if (!parser.parse) throw new Error('Missing parser.parse function');

    if (typeof parser.parse !== 'function') throw new Error('Invalid parser.parse function');

    const extensions = !Array.isArray(parser.extension) ? [parser.extension] : parser.extension;
    extensions.forEach(function(extension) {
      if (typeof extension !== 'string') throw new Error('Invalid parser.extension');
      parsers_registry[extension] = parser.parse;
    });
  });
};

module.exports = convict;
