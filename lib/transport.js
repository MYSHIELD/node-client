var bluebird = require('bluebird'),
  request = require('request');
/*
 * This is the transport layer. We use this class to perform the requests.
 * Currently, we are using request module to do this.
 * */
var MAX_TIMEOUT = 2 * 60 * 1000;  // 2 minutes
var CLIENT_NAME = 'node-unloq';
var CHUNK_PART_PREFIX = '\n',
  CHUNK_PART_SUFIX = '\n';
request.defaults.maxSockets = Infinity;
var transport = function UnloqTransport(auth, isEvented) {
  this.__method = 'POST';
  this.__timeout = 2000;  // This is the default timeout we'll use.
  this.__data = null;
  this.__valid = false;
  this.isEvented = (typeof isEvented === 'boolean' ? isEvented : false);
  this.__headers = {
    'content-type': 'application/json'
  };
  // We create our base URL from the auth object.
  this.url = auth.gateway;
  this.__attachAuth(auth);
  return this;
};

/*
 * Attaches the authentication object to the current transport object.
 * */
transport.prototype.__attachAuth = function AttachAuthentication(auth) {
  if (typeof auth.key === 'string' && typeof auth.secret !== 'string') {
    this.__headers['authorization'] = 'Bearer ' + auth.key;
  } else if (typeof auth.secret === 'string') {
    this.__headers['x-api-key'] = auth.key;
    if (auth.secret) {
      this.__headers['x-api-secret'] = auth.secret;
    }
  } else {
    throw new Error('UNLOQ requires either key/secret or key token');
  }

  this.__headers['x-requested-with'] = CLIENT_NAME;
  this.__valid = auth.isValid();
  this.auth = auth;
};

/*
 * Sets the path we want to point it to.
 * */
transport.prototype.endpoint = function SetEndpoint(point) {
  if (point.charAt(0) === '/') point = point.substr(1);
  this.url += point;
  return this;
};

/*
 * Sets the transport headers.
 * */
transport.prototype.headers = function SetHeaders(hData) {
  if (typeof hData === 'object' && hData !== null) {
    this.url = hData;
  }
  return this;
};
/*
 * Calling this will set a custom timeout to our http requests.
 * If it is called with a false value, we will disable timeout all together.
 * */
transport.prototype.timeout = function SetTimeout(val) {
  if (val === false) {
    this.__timeout = null;
    return this;
  }
  if (typeof val === 'number' && val > 0) {
    this.__timeout = val;
  }
  return this;
};

/*
 * Performs the call by calling the endpoint with the previously set method.
 * Default method is POST
 * This will return a bluebird promise.
 * */
transport.prototype.run = function DoRun() {
  var promiseObj = bluebird.promise(function (resolve, reject) {
    var self = this;
    if (!this.__valid) return reject(new Error('Authentication method is not valid.'));
    var opt = {
      followRedirect: false,
      headers: {}
    };
    if (this.__timeout) opt['timeout'] = this.__timeout;

    if (this.__data) {
      opt['json'] = true;
      opt['body'] = this.auth.encrypt(this.__data);
    }
    opt['headers'] = this.__headers;
    var req = request[this.__method.toLowerCase()](this.url, opt);
    /*
     * Cancels the current request
     * */
    promiseObj.cancelRequest = function CancelRequest() {
      isAborted = true;
      req.abort();
      var e = new Error('Request aborted');
      e.code = 'ABORTED';
      reject(e);
    };
    req.on('error', function (err) {
      var e;
      switch (err.code) {
        case 'ETIMEDOUT':
          e = new Error('Request timed out');
          e.code = 'TIMEOUT';
          break;
        case 'ENOTFOUND':
          e = new Error('Invalid Hostname or URL: ' + self.auth.gateway);
          e.code = 'INVALID_URL';
          break;
        default:
          e = err;
          e.message = 'The UNLOQ servers are currently unavailable.';
          e.code = 'INTERNAL_ERROR';
      }
      return reject(e);
    });
    var isCompleted = false,
      isAborted = false,
      isError = false;
    var fullData = "";
    req.on('response', function (resp) {
      if (self.isEvented && resp.headers['x-response-type'] !== 'event') {
        isError = true;
        return;
      }
      if (resp.statusCode !== 200) {
        isError = true;
      }
    }).on('data', function (d) {
      if (isCompleted) return;
      var chunk = d.toString();
      if (self.isEvented && !isError) return self.__parseEvent(chunk, promiseObj)
      fullData += chunk;
    }).on('end', function () {
      if (isAborted) {
        var e = new Error('Authentication request aborted.');
        e.code = 'ABORTED';
        return reject(e);
      }
      if (isCompleted) return;
      if (self.isEvented && !isError) return;
      try {
        var d = JSON.parse(fullData);
      } catch (e) {
        e.code = 'INVALID_RESPONSE';
        e.data = fullData;
        return reject(e);
      }
      if (typeof d !== 'object' || d == null) {
        var e = new Error('Invalid server response.');
        e.code = 'INVALID_RESPONSE';
        e.data = d;
        return reject(e);
      }
      if(typeof d.result === 'object' && d.result) {
        d.data = d.result;
        delete d.result;
        return resolve(d);
      }
      if(typeof d.error === 'object' && d.error) {
        var e = new Error(d.error.message || 'An error occurred');
        e.code = d.error.code || 'SERVER_ERROR';
        if(d.error.code === 'APPROVAL.DENIED') e.code = 'DENIED';
        if(d.error.status) e.status = d.error.status;
        return reject(e);
      }
      resolve(d);
    });
  }.bind(this));
  return promiseObj;
};

/*
 * This is an internal function that will parse incoming events.
 * */
transport.prototype.__parseEvent = function ParseEvents(chunk, promiseObj) {
  if (chunk === '\n' || chunk === ' ') return; // this is the connection ping.
  if (chunk.indexOf(CHUNK_PART_PREFIX) !== 0) return;
  // We have an intermediate chunk, which is basically an event.
  chunk = chunk.substr(CHUNK_PART_PREFIX.length);
  var isValid = chunk.substr(chunk.length - CHUNK_PART_SUFIX.length) === CHUNK_PART_SUFIX;
  if (!isValid) return;
  try {
    var data = JSON.parse(chunk);
    if (typeof data['event'] !== 'string') throw new Error('Event name missing from response');
    if (data.event === 'error') {
      return promiseObj.emit('error', data.data);
    }
    promiseObj.emit(data.event, data.data);
  } catch (e) {
    console.log('UNLOQ failed to parse chunk event');
    console.log(e);
    promiseObj.emit('error', e);
  }
};

/*
 * Wrapper methods over our HTTP methods.
 * */
transport.prototype.post = function DoPost(data) {
  this.__method = "POST";
  this.__data = data || {};
  return this.run();
};
transport.prototype.get = function DoGet() {
  this.__method = 'GET';
  return this.run();
};
transport.prototype.put = function DoPut() {
  this.__method = 'PUT';
  return this.run();
};
transport.prototype['delete'] = function DoDelete() {
  this.__method = 'DELETE';
  return this.run();
};

module.exports = transport;