var Utils     = require("./../utils")
  , DataTypes = require('./../data-types')
  , Helpers   = require('./helpers')
  , _         = require('lodash')

var HasManySingleLinked = require("./has-many-single-linked")
  , HasManyMultiLinked  = require("./has-many-double-linked")

module.exports = (function() {
  var HasMany = function(source, target, options) {
    var self = this

    this.associationType = 'HasMany'
    this.source = source
    this.target = target
    this.targetAssociation = null
    this.options = options
    this.sequelize = source.daoFactoryManager.sequelize
    this.through = options.through
    this.isSelfAssociation = (this.source.tableName === this.target.tableName)
    this.doubleLinked = false
    this.combinedTableName = Utils.combineTableNames(
      this.source.tableName,
      this.isSelfAssociation ? (this.options.as || this.target.tableName) : this.target.tableName
    )

    /*
     * Map joinTableModel/Name to through for BC
     */
    if (this.through === undefined) {
      this.through = this.options.joinTableModel || this.options.joinTableName;

      /*
       * If both are undefined, see if useJunctionTable was false (for self associations) - else assume through to be true
       */
      if (this.through === undefined) {
        if (this.options.useJunctionTable === false) {
          this.through = null;
        } else {
          this.through = true;
        }
      }
    }

    /*
     * Determine associationAccessor, especially for include options to identify the correct model
     */

    this.associationAccessor = this.options.as
    if (!this.associationAccessor && (typeof this.through === "string" || Object(this.through) === this.through)) {
      this.associationAccessor = this.through.tableName || this.through
    } 
    else if (!this.associationAccessor) {
      this.associationAccessor = this.combinedTableName
    }

    /*
     * Find partner DAOFactory if present, to identify double linked association
     */
     if (this.through) {
      _.each(this.target.associations, function (association, accessor) {
        if (self.source === association.target) {
          var paired = false

          // If through is default, we determine pairing by the accesor value (i.e. DAOFactory's using as won't pair, but regular ones will)
          if (self.through === true && accessor === self.associationAccessor) {
            paired = true
          }
          // If through is not default, determine pairing by through value (model/string)
          if (self.through !== true && self.options.through === association.options.through) {
            paired = true
          }
          // If paired, set properties identifying both associations as double linked, and allow them to each eachtoerh
          if (paired) {
            self.doubleLinked = true
            association.doubleLinked = true
            
            self.targetAssociation = association
            association.targetAssociation = self
          }
        }
      })
    }

    /*
     * If we are double linked, and through is either default or a string, we create the through model and set it on both associations
     */
    if (this.doubleLinked) {
      if (this.through === true) {
        this.through = this.combinedTableName
      }
      if (typeof this.through === "string") {
        this.through = this.sequelize.define(this.through, {}, _.extend(this.options, {
          tableName: this.through
        }))

        this.targetAssociation.through = this.through
      }
    }

    this.options.tableName = this.combinedName = (this.through === Object(this.through) ? this.through.tableName : this.through)

    var as = (this.options.as || Utils.pluralize(this.target.tableName, this.target.options.language))

    this.accessors = {
      get: Utils._.camelize('get_' + as),
      set: Utils._.camelize('set_' + as),
      add: Utils._.camelize(Utils.singularize('add_' + as, this.target.options.language)),
      remove: Utils._.camelize(Utils.singularize('remove_' + as, this.target.options.language)),
      hasSingle: Utils._.camelize(Utils.singularize('has_' + as, this.target.options.language)),
      hasAll: Utils._.camelize('has_' + as)
    }
  }

  // the id is in the target table
  // or in an extra table which connects two tables
  HasMany.prototype.injectAttributes = function() {
    var doubleLinked = this.doubleLinked
      , self         = this

    this.identifier = this.options.foreignKey || Utils._.underscoredIf(Utils.singularize(this.source.tableName, this.source.options.language) + "Id", this.options.underscored)

    // is there already a single sided association between the source and the target?
    // or is the association on the model itself?
    if ((this.isSelfAssociation && this.through) || doubleLinked) {
      // remove the obsolete association identifier from the source
      if (this.isSelfAssociation) {
        this.foreignIdentifier = Utils._.underscoredIf((this.options.as || this.target.tableName) + 'Id', this.options.underscored)
      } else {
        this.foreignIdentifier = this.targetAssociation.identifier
        this.targetAssociation.foreignIdentifier = this.identifier

        if (isForeignKeyDeletionAllowedFor.call(this, this.source, this.foreignIdentifier)) {
          delete this.source.rawAttributes[this.foreignIdentifier]
        }

        if (isForeignKeyDeletionAllowedFor.call(this, this.target, this.identifier)) {
          delete this.targetAssociation.source.rawAttributes[this.identifier]
        }
      }

      // define a new model, which connects the models
      var combinedTableAttributes = {}
      var sourceKeys = Object.keys(this.source.primaryKeys);
      var sourceKeyType = ((!this.source.hasPrimaryKeys || sourceKeys.length !== 1) ? DataTypes.INTEGER : this.source.rawAttributes[sourceKeys[0]].type)
      var targetKeys = Object.keys(this.target.primaryKeys);
      var targetKeyType = ((!this.target.hasPrimaryKeys || targetKeys.length !== 1) ? DataTypes.INTEGER : this.target.rawAttributes[targetKeys[0]].type)
      combinedTableAttributes[this.identifier] = {type: sourceKeyType, primaryKey: true}
      combinedTableAttributes[this.foreignIdentifier] = {type: targetKeyType, primaryKey: true}

      // remove any previously defined PKs
      Utils._.each(this.through.attributes, function(dataTypeString, attributeName) {
        if (dataTypeString.toString().indexOf('PRIMARY KEY') !== -1) {
          delete self.through.rawAttributes[attributeName]
        }
      })

      this.through.rawAttributes = Utils._.merge(this.through.rawAttributes, combinedTableAttributes)
      this.through.init(this.through.daoFactoryManager)

      if (this.options.syncOnAssociation) {
        this.through.sync()
      }
    } else {
      var newAttributes = {}
      newAttributes[this.identifier] = { type: this.options.keyType || DataTypes.INTEGER }
      Helpers.addForeignKeyConstraints(newAttributes[this.identifier], this.source, this.target, this.options)
      Utils._.defaults(this.target.rawAttributes, newAttributes)
    }

    // Sync attributes and setters/getters to DAO prototype
    this.target.refreshAttributes()
    this.source.refreshAttributes()

    return this
  }

  HasMany.prototype.injectGetter = function(obj) {
    var self = this

    obj[this.accessors.get] = function(options) {
      var Class = Object(self.through) === self.through ? HasManyMultiLinked : HasManySingleLinked
      return new Class(self, this).injectGetter(options)
    }

    obj[this.accessors.hasAll] = function(objects, options) {
      var instance = this;
      var customEventEmitter = new Utils.CustomEventEmitter(function() {
        instance[self.accessors.get](options)
          .error(function(err) { customEventEmitter.emit('error', err) })
          .success(function(associatedObjects) {
            customEventEmitter.emit('success',
              Utils._.all(objects, function(o) {
                return Utils._.any(associatedObjects, function(associatedObject) {
                  return Utils._.all(associatedObject.identifiers, function(key, identifier) {
                    return o[identifier] == associatedObject[identifier];
                  });
                })
              })
            )
          })
      })
      return customEventEmitter.run()
    }

    obj[this.accessors.hasSingle] = function(o, options) {
      var instance           = this
      var customEventEmitter = new Utils.CustomEventEmitter(function() {
        instance[self.accessors.get](options)
        .error(function(err){ customEventEmitter.emit('error', err)})
        .success(function(associatedObjects) {
          customEventEmitter.emit('success',
            Utils._.any(associatedObjects, function(associatedObject) {
              return Utils._.all(associatedObject.identifiers, function(key, identifier) {
                return o[identifier] == associatedObject[identifier];
              });
            })
          )
        })
      })
      return customEventEmitter.run()
    }
    return this
  }

  HasMany.prototype.injectSetter = function(obj) {
    var self = this

    obj[this.accessors.set] = function(newAssociatedObjects, defaultAttributes) {
      if (newAssociatedObjects === null) {
        newAssociatedObjects = []
      }

      var instance = this

      // define the returned customEventEmitter, which will emit the success event once everything is done
      return new Utils.CustomEventEmitter(function(emitter) {
        instance[self.accessors.get]()
          .success(function(oldAssociatedObjects) {
            var Class = self.doubleLinked ? HasManyMultiLinked : HasManySingleLinked
            new Class(self, instance).injectSetter(emitter, oldAssociatedObjects, newAssociatedObjects, defaultAttributes)
          })
          .error(function(err) {
            emitter.emit('error', err)
          })
          .on('sql', function(sql) {
            emitter.emit('sql', sql)
          })
      }).run()
    }

    obj[this.accessors.add] = function(newAssociatedObject, additionalAttributes) {
      var instance = this
        , primaryKeys = Object.keys(newAssociatedObject.daoFactory.primaryKeys || {})
        , primaryKey = primaryKeys.length === 1 ? primaryKeys[0] : 'id'
        , where = {}


      where[newAssociatedObject.daoFactory.tableName+'.'+primaryKey] = newAssociatedObject[primaryKey]
      return new Utils.CustomEventEmitter(function(emitter) {
        instance[self.accessors.get]({ where: where })
          .error(function(err){ emitter.emit('error', err)})
          .success(function(currentAssociatedObjects) {
            if (currentAssociatedObjects.length === 0 || self.hasJoinTableModel === true) {
              var Class = self.doubleLinked ? HasManyMultiLinked : HasManySingleLinked
              new Class(self, instance).injectAdder(emitter, newAssociatedObject, additionalAttributes, !!currentAssociatedObjects.length)
            } else {
              emitter.emit('success', newAssociatedObject);
            }
          })
      }).run()
    }

    obj[this.accessors.remove] = function(oldAssociatedObject) {
      var instance = this
      var customEventEmitter = new Utils.CustomEventEmitter(function() {
        instance[self.accessors.get]().success(function(currentAssociatedObjects) {
          var newAssociations = []
            , oldAssociations = []

          currentAssociatedObjects.forEach(function(association) {
            if (!Utils._.isEqual(oldAssociatedObject.identifiers, association.identifiers)) {
              newAssociations.push(association)
            }
          })

          var tick = 0
          var next = function(err, i) {
            if (!!err || i >= oldAssociations.length) {
              return run(err)
            }

            oldAssociations[i].destroy().error(function(err) {
              next(err)
            })
            .success(function() {
              tick++
              next(null, tick)
            })
          }

          var run = function(err) {
            if (!!err) {
              return customEventEmitter.emit('error', err)
            }

            instance[self.accessors.set](newAssociations)
              .success(function() { customEventEmitter.emit('success', null) })
              .error(function(err) { customEventEmitter.emit('error', err) })
          }

          if (oldAssociations.length > 0) {
            next(null, tick)
          } else {
            run()
          }
        })
      })
      return customEventEmitter.run()
    }

    return this
  }

  /**
   * The method checks if it is ok to delete the previously defined foreign key.
   * This is done because we need to keep the foreign key if another association
   * is depending on it.
   *
   * @param  {DaoFactory}  daoFactory The source or target DaoFactory of this assocation
   * @param  {[type]}  identifier     The name of the foreign key identifier
   * @return {Boolean}                Whether or not the deletion of the foreign key is ok.
   */
  var isForeignKeyDeletionAllowedFor = function(daoFactory, identifier) {
    var isAllowed        = true
      , associationNames = Utils._.without(Object.keys(daoFactory.associations), this.associationAccessor)

    associationNames.forEach(function(associationName) {
      if (daoFactory.associations[associationName].identifier === identifier) {
        isAllowed = false
      }
    })

    return isAllowed
  }

  return HasMany
})()
