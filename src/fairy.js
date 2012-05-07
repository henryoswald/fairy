// Generated by CoffeeScript 1.3.1
(function() {
  var Fairy, Queue, key_queues, prefix, redis, uuid,
    __bind = function(fn, me){ return function(){ return fn.apply(me, arguments); }; },
    __slice = [].slice;

  uuid = require('node-uuid');

  redis = require('redis');

  prefix = 'FAIRY';

  key_queues = "" + prefix + ":QUEUES";

  Fairy = (function() {

    Fairy.name = 'Fairy';

    function Fairy(redis) {
      this.redis = redis;
      this.queue_pool = {};
    }

    Fairy.prototype.queue = function(name) {
      if (this.queue_pool[name]) {
        return this.queue_pool[name];
      }
      this.redis.sadd(key_queues, name);
      return this.queue_pool[name] = new Queue(this.redis, name);
    };

    Fairy.prototype.queues = function(callback) {
      var _this = this;
      return this.redis.smembers(key_queues, function(err, res) {
        return callback(res.map(function(name) {
          return _this.queue(name);
        }));
      });
    };

    Fairy.prototype.statistics = function(callback) {
      var result;
      result = [];
      return this.queues(function(queues) {
        var total_queues;
        total_queues = queues.length;
        return queues.forEach(function(queue, i) {
          return queue.statistics(function(statistics) {
            statistics.name = queue.name;
            result[i] = statistics;
            if (!--total_queues) {
              return callback(result);
            }
          });
        });
      });
    };

    return Fairy;

  })();

  Queue = (function() {

    Queue.name = 'Queue';

    function Queue(redis, name) {
      this.redis = redis;
      this.name = name;
      this.reschedule = __bind(this.reschedule, this);

      this.regist = __bind(this.regist, this);

    }

    Queue.prototype.key = function(key) {
      return "" + prefix + ":" + key + ":" + this.name;
    };

    Queue.prototype.polling_interval = 5;

    Queue.prototype.retry_delay = 0.1 * 1000;

    Queue.prototype.retry_limit = 2;

    Queue.prototype.recent_size = 10;

    Queue.prototype.slowest_size = 10;

    Queue.prototype.enqueue = function() {
      var args, callback, _i;
      args = 2 <= arguments.length ? __slice.call(arguments, 0, _i = arguments.length - 1) : (_i = 0, []), callback = arguments[_i++];
      this.redis.hincrby(this.key('STATISTICS'), 'total', 1);
      if (typeof callback === 'function') {
        args.push(Date.now());
        return this.redis.rpush(this.key('SOURCE'), JSON.stringify(args), callback);
      } else {
        args.push(callback);
        args.push(Date.now());
        return this.redis.rpush(this.key('SOURCE'), JSON.stringify(args));
      }
    };

    Queue.prototype.regist = function(handler) {
      var errors, poll, process, processing, queued_time, retry_count,
        _this = this;
      retry_count = null;
      queued_time = null;
      processing = null;
      errors = [];
      (poll = function() {
        _this.redis.watch(_this.key('SOURCE'));
        return _this.redis.lindex(_this.key('SOURCE'), 0, function(err, res) {
          var multi, queued, task;
          if (res) {
            task = JSON.parse(res);
            queued = "" + (_this.key('QUEUED')) + ":" + task[0];
            multi = _this.redis.multi();
            multi.lpop(_this.key('SOURCE'));
            multi.rpush(queued, res);
            return multi.exec(function(multi_err, multi_res) {
              if (multi_res && multi_res[1] === 1) {
                return process(queued, task, true);
              }
              return poll();
            });
          } else {
            _this.redis.unwatch();
            return setTimeout(poll, _this.polling_interval);
          }
        });
      })();
      return process = function(queued, task, is_new_task) {
        var start_time;
        start_time = Date.now();
        if (is_new_task) {
          processing = uuid.v4();
          queued_time = task.pop();
          _this.redis.hset(_this.key('PROCESSING'), processing, JSON.stringify(__slice.call(task).concat([start_time])));
          retry_count = _this.retry_limit;
          errors = [];
        }
        return handler.apply(null, __slice.call(task).concat([function(err, res) {
          var next, process_time, push_blocked, push_failed, retry;
          process_time = Date.now() - start_time;
          if (err) {
            errors.push(err.message || '');
            push_failed = function() {
              return _this.redis.rpush(_this.key('FAILED'), JSON.stringify(__slice.call(task).concat([queued_time], [Date.now()], [errors])));
            };
            push_blocked = function() {
              _this.redis.hdel(_this.key('PROCESSING'), processing);
              return _this.redis.sadd(_this.key('BLOCKED'), task[0]);
            };
            retry = function() {
              return setTimeout((function() {
                return process(queued, task);
              }), _this.retry_delay);
            };
            switch (err["do"]) {
              case 'block':
                push_failed();
                push_blocked();
                return poll();
              case 'block-after-retry':
                if (retry_count--) {
                  return retry();
                } else {
                  push_failed();
                  push_blocked();
                  return poll();
                }
                break;
              default:
                if (retry_count--) {
                  return retry();
                }
                push_failed();
            }
          }
          return (next = function() {
            var multi;
            _this.redis.hdel(_this.key('PROCESSING'), processing);
            _this.redis.watch(queued);
            multi = _this.redis.multi();
            multi.lpop(queued);
            multi.lindex(queued, 0);
            return multi.exec(function(multi_err, multi_res) {
              if (multi_res) {
                if (!err) {
                  _this.redis.hincrby(_this.key('STATISTICS'), 'finished', 1);
                  _this.redis.hincrby(_this.key('STATISTICS'), 'total_pending_time', start_time - queued_time);
                  _this.redis.hincrby(_this.key('STATISTICS'), 'total_processing_time', process_time);
                  _this.redis.lpush(_this.key('RECENT'), JSON.stringify(__slice.call(task).concat([start_time - queued_time], [process_time])));
                  _this.redis.ltrim(_this.key('RECENT'), 0, _this.recent_size - 1);
                  _this.redis.zadd(_this.key('SLOWEST'), process_time, JSON.stringify(task));
                  _this.redis.zremrangebyrank(_this.key('SLOWEST'), 0, -_this.slowest_size - 1);
                }
                if (multi_res[1]) {
                  return process(queued, JSON.parse(multi_res[1]), true);
                } else {
                  return poll();
                }
              } else {
                return next();
              }
            });
          })();
        }]));
      };
    };

    Queue.prototype.reschedule = function(callback) {
      var _this = this;
      if (callback == null) {
        callback = (function() {});
      }
      this.redis.watch(this.key('FAILED'));
      this.redis.watch(this.key('BLOCKED'));
      return this.failed_tasks(function(tasks) {
        var requeued_tasks;
        requeued_tasks = [];
        requeued_tasks.push.apply(requeued_tasks, tasks.map(function(task) {
          return JSON.stringify(task.slice(0, -2));
        }));
        return _this.blocked_groups(function(groups) {
          var group, start_transaction, total_groups, _i, _len, _ref, _results;
          if (groups.length) {
            (_ref = _this.redis).watch.apply(_ref, groups.map(function(group) {
              return "" + (_this.key('QUEUED')) + ":" + group;
            }));
          }
          start_transaction = function() {
            var multi;
            multi = _this.redis.multi();
            if (requeued_tasks.length) {
              multi.rpush.apply(multi, [_this.key('SOURCE')].concat(__slice.call(requeued_tasks)));
            }
            multi.del(_this.key('FAILED'));
            if (groups.length) {
              multi.del.apply(multi, groups.map(function(group) {
                return "" + (_this.key('QUEUED')) + ":" + group;
              }));
            }
            multi.del(_this.key('BLOCKED'));
            return multi.exec(function(multi_err, multi_res) {
              if (multi_res) {
                return callback();
              } else {
                return _this.reschedule(callback);
              }
            });
          };
          if (total_groups = groups.length) {
            _results = [];
            for (_i = 0, _len = groups.length; _i < _len; _i++) {
              group = groups[_i];
              _results.push(_this.redis.lrange("" + (_this.key('QUEUED')) + ":" + group, 1, -1, function(err, res) {
                requeued_tasks.push.apply(requeued_tasks, res);
                if (!--total_groups) {
                  return start_transaction();
                }
              }));
            }
            return _results;
          } else {
            return start_transaction();
          }
        });
      });
    };

    Queue.prototype.recently_finished_tasks = function(callback) {
      return this.redis.lrange(this.key('RECENT'), 0, -1, function(err, res) {
        return callback(res.map(function(entry) {
          return JSON.parse(entry);
        }));
      });
    };

    Queue.prototype.failed_tasks = function(callback) {
      return this.redis.lrange(this.key('FAILED'), 0, -1, function(err, res) {
        return callback(res.map(function(entry) {
          return JSON.parse(entry);
        }));
      });
    };

    Queue.prototype.blocked_groups = function(callback) {
      return this.redis.smembers(this.key('BLOCKED'), function(err, res) {
        return callback(res.map(function(entry) {
          return JSON.parse(entry);
        }));
      });
    };

    Queue.prototype.slowest_tasks = function(callback) {
      return this.redis.zrevrange(this.key('SLOWEST'), 0, -1, "WITHSCORES", function(err, res) {
        var i;
        res = res.map(function(entry) {
          return JSON.parse(entry);
        });
        return callback((function() {
          var _i, _ref, _results;
          _results = [];
          for (i = _i = 0, _ref = res.length; _i < _ref; i = _i += 2) {
            _results.push(__slice.call(res[i]).concat([res[i + 1]]));
          }
          return _results;
        })());
      });
    };

    Queue.prototype.processing_tasks = function(callback) {
      return this.redis.hvals(this.key('PROCESSING'), function(err, res) {
        return callback(res.map(function(entry) {
          return JSON.parse(entry);
        }));
      });
    };

    Queue.prototype.statistics = function(callback) {
      var multi,
        _this = this;
      multi = this.redis.multi();
      multi.hgetall(this.key('STATISTICS'));
      multi.llen(this.key('FAILED'));
      multi.smembers(this.key('BLOCKED'));
      return multi.exec(function(multi_err, multi_res) {
        var group, result, _i, _len, _ref;
        result = {
          total_tasks: multi_res[0].total || 0,
          finished_tasks: multi_res[0].finished || 0,
          average_pending_time: Math.round(multi_res[0].total_pending_time * 100 / multi_res[0].finished) / 100,
          average_processing_time: Math.round(multi_res[0].total_processing_time * 100 / multi_res[0].finished) / 100
        };
        if (!result.finished_tasks) {
          result.average_pending_time = '-';
          result.average_processing_time = '-';
        }
        result.failed_tasks = multi_res[1];
        multi = _this.redis.multi();
        _ref = multi_res[2];
        for (_i = 0, _len = _ref.length; _i < _len; _i++) {
          group = _ref[_i];
          multi.llen("" + (_this.key('QUEUED')) + ":" + group);
        }
        return multi.exec(function(multi_err2, multi_res2) {
          result.blocked = {
            groups: multi_res[2].length,
            tasks: multi_res2.reduce((function(a, b) {
              return a + b;
            }), -multi_res[2].length)
          };
          result.pending_tasks = result.total_tasks - result.finished_tasks - result.blocked.tasks - result.failed_tasks;
          return callback(result);
        });
      });
    };

    return Queue;

  })();

  exports.connect = function(options) {
    var client;
    if (options == null) {
      options = {};
    }
    client = redis.createClient(options.port, options.host);
    if (options.password != null) {
      client.auth(options.password);
    }
    return new Fairy(client);
  };

}).call(this);
