{exec} = require 'child_process'

task      = 'TEST0'
fairy     = require("#{__dirname}/../..").connect()
queue     = fairy.queue task

queue.regist (group, sequence, callback) ->
  setTimeout ->
    exec 'echo ' + sequence + ' >> ' + "#{__dirname}/" + group + '.dmp', ->
      callback null
  , Math.random() * 1
