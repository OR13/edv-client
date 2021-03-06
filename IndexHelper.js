/*!
 * Copyright (c) 2019 Digital Bazaar, Inc. All rights reserved.
 */
'use strict';

import {TextEncoder} from './util.js';
import split from 'split-string';

const ATTRIBUTE_PREFIXES = ['content', 'meta'];

export class IndexHelper {
  /**
   * Creates a new IndexHelper instance that can be used to blind EDV
   * document attributes to enable indexing.
   *
   * @return {IndexHelper}.
   */
  constructor() {
    this.indexes = new Map();
  }

  /**
   * Ensures that future documents inserted or updated using this IndexHelper
   * instance will be indexed according to the given attribute, provided that
   * they contain that attribute.
   *
   * @param {Object} options - The options to use.
   * @param {Array|Object} options.attribute the attribute name or an array of
   *   attribute names.
   * @param {boolean} [options.unique=false] `true` if attribute values should
   *   be considered unique, `false` if not.
   */
  ensureIndex({attribute, unique = false}) {
    if(!Array.isArray(attribute)) {
      attribute = [attribute];
    }
    if(!attribute.every(x => typeof x === 'string')) {
      throw new TypeError(
        '"attribute" must be a string or an array of strings.');
    }
    attribute.forEach(x => {
      // parse attribute to ensure it is valid before adding the index entry
      this._parseAttribute(x);
      this.indexes.set(x, unique);
    });
  }

  /**
   * Creates an indexable entry of blinded attributes for the given document
   * using the HMAC associated with this instance.
   *
   * @param {Object} options - The options to use.
   * @param {Object} options.hmac an HMAC API with `id`, `sign`, and `verify`
   *   properties.
   * @param {Object} options.doc the document to create the indexable entry for.
   *
   * @return {Promise<Object>} resolves to the new indexable entry.
   */
  async createEntry({hmac, doc}) {
    _assertHmac(hmac);

    // handle prefix here
    const {indexes} = this;
    const entry = {
      hmac: {
        id: hmac.id,
        type: hmac.type
      }
    };

    // ensure current iteration/version matches doc's
    entry.sequence = doc.sequence;

    // blind all attributes specifies in current index set
    const blindOps = [];
    for(const [indexKey, unique] of indexes.entries()) {
      let value = this._dereferenceAttribute({attribute: indexKey, doc});
      if(value === undefined) {
        continue;
      }
      if(!Array.isArray(value)) {
        value = [value];
      }
      for(const v of value) {
        blindOps.push(
          this._blindAttribute({hmac, key: indexKey, value: v, unique}));
      }
    }
    entry.attributes = await Promise.all(blindOps);

    return entry;
  }

  /**
   * Returns a shallow copy of the array of indexed entries for the given
   * document where any existing entry matching the HMAC associated with this
   * instance is updated to include the current document attributes. If no
   * existing entry is found, a new entry is appended to the shallow copy
   * prior to its return.
   *
   * @param {Object} options - The options to use.
   * @param {Object} options.hmac an HMAC API with `id`, `sign`, and `verify`
   *   properties.
   * @param {Object} options.doc the document to create or update an indexable
   *   entry for.
   *
   * @return {Promise<Array>} resolves to the updated array of indexable
   *   entries.
   */
  async updateEntry({hmac, doc}) {
    _assertHmac(hmac);

    // get previously indexed entries to update
    let {indexed = []} = doc;
    if(!Array.isArray(indexed)) {
      throw new TypeError('"indexed" must be an array.');
    }

    // create new entry
    const entry = await this.createEntry({hmac, doc});

    // find existing entry in `indexed` by hmac ID and type
    const i = indexed.findIndex(
      e => e.hmac.id === hmac.id && e.hmac.type === hmac.type);

    // replace or append new entry
    indexed = indexed.slice();
    if(i === -1) {
      indexed.push(entry);
    } else {
      indexed[i] = entry;
    }

    return indexed;
  }

  /**
   * Builds a query that can be submitted to an EDV index service.
   *
   * @param {Object} options - The options to use.
   * @param {Object} options.hmac an HMAC API with `id`, `sign`, and `verify`
   *   properties.
   * @param {Object|Array} [options.equals] an object with key-value attribute
   *   pairs to match or an array of such objects.
   * @param {string|Array} [options.has] a string with an attribute name to
   *   match or an array of such strings.
   *
   * @return {Promise<Object>} resolves to the built query.
   */
  async buildQuery({hmac, equals, has}) {
    _assertHmac(hmac);

    // validate params
    if(equals === undefined && has === undefined) {
      throw new Error('Either "equals" or "has" must be defined.');
    }
    if(equals !== undefined && has !== undefined) {
      throw new Error('Only one of "equals" or "has" may be defined at once.');
    }
    if(equals !== undefined) {
      if(Array.isArray(equals)) {
        if(!equals.every(x => (x && typeof x === 'object'))) {
          throw new TypeError('"equals" must be an array of objects.');
        }
      } else if(!(equals && typeof equals === 'object')) {
        throw new TypeError(
          '"equals" must be an object or an array of objects.');
      }
    }
    if(has !== undefined) {
      if(Array.isArray(has)) {
        if(!has.every(x => (x && typeof x === 'string'))) {
          throw new TypeError('"has" must be an array of strings.');
        }
      } else if(typeof has !== 'string') {
        throw new TypeError('"has" must be a string or an array of strings.');
      }
    }

    const query = {
      index: hmac.id,
    };

    if(equals) {
      // blind `equals`
      if(!Array.isArray(equals)) {
        equals = [equals];
      }
      query.equals = await Promise.all(equals.map(async equal => {
        const result = {};
        for(const key in equal) {
          const value = equal[key];
          const attr = await this._blindAttribute({hmac, key, value});
          result[attr.name] = attr.value;
        }
        return result;
      }));
    } else if(has !== undefined) {
      // blind `has`
      if(!Array.isArray(has)) {
        has = [has];
      }
      query.has = await Promise.all(
        has.map(key => this._blindString(hmac, key)));
    }
    return query;
  }

  /**
   * Blinds a single attribute using the internal HMAC API.
   *
   * @param {Object} options - The options to use.
   * @param {Object} options.hmac an HMAC API with `id`, `sign`, and `verify`
   *   properties.
   * @param {string} options.key a key associated with a value.
   * @param {Any} options.value the value associated with the key for the
   *   attribute.
   * @param {boolean} options.unique `true` to include a unique flag on the
   *   output.
   *
   * @return {Promise<Object>} resolves to an object `{name, value}`.
   */
  async _blindAttribute({hmac, key, value, unique = false}) {
    // salt values with key to prevent cross-key leakage
    value = JSON.stringify({key: value});
    const [blindedName, blindedValue] = await Promise.all(
      [this._blindString(hmac, key), this._blindString(hmac, value)]);
    const result = {name: blindedName, value: blindedValue};
    if(unique) {
      result.unique = true;
    }
    return result;
  }

  /**
   * Blinds a string using the internal HMAC API.
   *
   * @param {Object} hmac an HMAC API with `id`, `sign`, and `verify`
   *   properties.
   * @param {string} value the value to blind.
   *
   * @return {Promise<String>} resolves to the blinded value.
   */
  async _blindString(hmac, value) {
    // convert value to Uint8Array
    const data = new TextEncoder().encode(value);
    return hmac.sign({data});
  }

  _parseAttribute(attribute) {
    const keys = split(attribute);
    if(keys.length === 0) {
      throw new Error(
        `Invalid attribute "${attribute}"; it must be of the form ` +
        '"content.foo.bar".');
    }
    // ensure prefix is valid
    if(!ATTRIBUTE_PREFIXES.includes(keys[0])) {
      throw new Error(
        'Attribute "${attribute}" must be prefixed with one of the ' +
        `following: ${ATTRIBUTE_PREFIXES.join(', ')}`);
    }
    return keys;
  }

  _dereferenceAttribute({attribute, keys, doc}) {
    keys = keys || this._parseAttribute(attribute);
    let value = doc;
    while(keys.length > 0) {
      if(!(value && typeof value === 'object')) {
        return undefined;
      }
      const key = keys.shift();
      value = value[key];
      if(Array.isArray(value)) {
        // there are more keys, so recurse into array
        return value
          .map(v => this._dereferenceAttribute({keys: keys.slice(), doc: v}))
          .filter(v => v !== undefined);
      }
    }
    return value;
  }
}

function _assertHmac(hmac) {
  if(!(hmac && typeof hmac === 'object' && typeof hmac.id === 'string' &&
    typeof hmac.sign === 'function' && typeof hmac.verify === 'function')) {
    throw new TypeError(
      '"hmac" must be an object with "id", "sign", and "verify" properties.');
  }
}
