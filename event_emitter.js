// EventEmitter with support for catch-all listeners and mixin
// TODO: Write tests

/*
* Usage

    EventEmitterModule = require './event_emitter'

    class MyClass

    * Apply EventEmitterModule to MyClass
    EventEmitterModule.mixin MyClass

    obj = new MyClass
    obj.on 'testevent', (a, b, c) ->
      console.log "received testevent a=#{a} b=#{b} c=#{c}"

    obj.onAny (eventName, data...) ->
      console.log "received eventName=#{eventName} data=#{data}"

    obj.emit 'testevent', 111, 222, 333
    obj.emit 'anotherevent', 'hello'

Or EventEmitterModule can be injected dynamically into an object
(with slightly worse performance):

    class MyClass
      constructor: ->
        EventEmitterModule.inject this

    obj = new MyClass
    obj.on 'testevent', ->
      console.log "received testevent"

    obj.emit 'testevent'
*/

class EventEmitterModule {
  // Apply EventEmitterModule to the class
  static mixin(cls) {
    for (let name of Object.keys(EventEmitterModule.prototype || {})) {
      let value = EventEmitterModule.prototype[name];
      try {
        cls.prototype[name] = value;
      } catch (e) {
        throw new Error("Call EventEmitterModule.mixin() after the class definition");
      }
    }
  }

  // Inject EventEmitterModule into the object
  static inject(obj) {
    for (let name of Object.keys(EventEmitterModule.prototype || {})) {
      let value = EventEmitterModule.prototype[name];
      obj[name] = value;
    }
    obj.eventListeners = {};
    obj.catchAllEventListeners = [];
  }

  emit(name, ...data) {
    let listener;
    if ((this.eventListeners != null ? this.eventListeners[name] : undefined) != null) {
      for (listener of Array.from(this.eventListeners[name])) {
        listener(...data);
      }
    }
    if (this.catchAllEventListeners != null) {
      for (listener of Array.from(this.catchAllEventListeners)) {
        listener(name, ...data);
      }
    }
  }

  onAny(listener) {
    if (this.catchAllEventListeners != null) {
      return this.catchAllEventListeners.push(listener);
    } else {
      return this.catchAllEventListeners = [ listener ];
    }
  }

  offAny(listener) {
    if (this.catchAllEventListeners != null) {
      for (let i = 0; i < this.catchAllEventListeners.length; i++) {
        let _listener = this.catchAllEventListeners[i];
        if (_listener === listener) {
          this.catchAllEventListeners.splice(i, i - i + 1, ...[].concat([]));  // remove element at index i
        }
      }
    }
  }

  on(name, listener) {
    if ((this.eventListeners == null)) {
      this.eventListeners = {};
    }
    if (this.eventListeners[name] != null) {
      return this.eventListeners[name].push(listener);
    } else {
      return this.eventListeners[name] = [ listener ];
    }
  }

  removeListener(name, listener) {
    if ((this.eventListeners != null ? this.eventListeners[name] : undefined) != null) {
      for (let i = 0; i < this.eventListeners[name].length; i++) {
        let _listener = this.eventListeners[name][i];
        if (_listener === listener) {
          this.eventListeners.splice(i, i - i + 1, ...[].concat([]));  // remove element at index i
        }
      }
    }
  }

  off(name, listener) {
    return this.removeListener(...arguments);
  }
}

export default EventEmitterModule;
