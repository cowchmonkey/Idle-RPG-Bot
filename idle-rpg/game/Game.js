const Database = require('../database/Database');
const enumHelper = require('../utils/enumHelper');
const Event = require('./utils/Event');
const { errorLog } = require('../utils/logger');
const globalSpells = require('./data/globalSpells');

/**
 * GANE CLASS
 */
class Game {

  constructor(discordHook, Helper) {
    this.discordHook = discordHook;
    this.activeSpells = [];
    this.config = '';

    this.Helper = Helper;
    this.Database = new Database(Helper);
    this.Event = new Event(this.Database, Helper, discordHook);
    if (process.env.NODE_ENV.includes('production')) {
      this.Database.loadGame()
        .then((loadedConfig) => {
          this.config = loadedConfig;
          if (this.config.spells.activeBless === 0) {
            this.config.multiplier = 1;
            this.Database.updateGame(this.config);
          }
        })
        .then(() => console.log(`Config loaded\nMultiplier:${this.config.multiplier}\nActive Bless:${this.config.spells.activeBless}\nPrize Pool:${this.config.dailyLottery.prizePool}`))
        .then(() => {
          for (let i = 0; i < this.config.spells.activeBless; i++) {
            setTimeout(() => {
              this.config.spells.activeBless--;
              this.config.multiplier -= 1;
              this.config.multiplier = this.config.multiplier <= 0 ? 1 : this.config.multiplier;
              if (this.config.spells.activeBless === 0) {
                this.config.multiplier = 1;
              }
              this.Database.updateGame(this.config);
            }, 1800000 + (5000 * i));
          }
        });
    } else {
      this.config = {
        multiplier: 1,
        spells: {
          activeBless: 0
        },
        dailyLottery: {
          prizePool: 1500
        }
      };
    }
  }

  /**
   * Loads player by discordID and rolls a dice to select which type of event to activate
   * @param {Number} player
   * @param {Array} onlinePlayers
   * @param {*} twitchBot
   */
  selectEvent(discordBot, player, onlinePlayers, twitchBot) {
    const randomEvent = this.Helper.randomBetween(0, 2);

    this.Database.loadPlayer(player.discordId)
      .then((selectedPlayer) => {
        if (!selectedPlayer) {
          return this.Database.createNewPlayer(player.discordId, player.name)
            .then((newPlayer) => {
              this.Helper.sendMessage(this.discordHook, twitchBot, selectedPlayer, false, `${this.Helper.generatePlayerName(newPlayer, true)} was born in \`${newPlayer.map.name}\`! Welcome to the world of Idle-RPG!`);

              return newPlayer;
            });
        } else if (selectedPlayer.events === 0) {
          selectedPlayer.map = this.Event.MapClass.getRandomTown();
          this.Helper.sendMessage(this.discordHook, twitchBot, selectedPlayer, false, `${this.Helper.generatePlayerName(selectedPlayer, true)} was reborn in \`${selectedPlayer.map.name}\`!`);
        }

        return selectedPlayer;
      })
      .then((selectedPlayer) => {
        selectedPlayer.events++;
        if (selectedPlayer.updated_at) {
          const lastUpdated = (new Date().getTime() - selectedPlayer.updated_at.getTime()) / 1000;
          console.log(`${selectedPlayer.name} was last updated: ${this.Helper.secondsToTimeFormat(Math.floor(lastUpdated))} ago.`);
        }

        return selectedPlayer;
      })
      .then((selectedPlayer) => {
        selectedPlayer.name = player.name;

        this.Helper.passiveRegen(selectedPlayer, ((5 * selectedPlayer.level) / 2) + (selectedPlayer.stats.end / 2), ((5 * selectedPlayer.level) / 2) + (selectedPlayer.stats.int / 2));
        switch (randomEvent) {
          case 0:
            return this.moveEvent(selectedPlayer, onlinePlayers)
              .then(updatedPlayer => this.Database.savePlayer(updatedPlayer))
              .catch(err => errorLog.error(err));
          case 1:
            return this.attackEvent(selectedPlayer, onlinePlayers)
              .then(updatedPlayer => this.Database.savePlayer(updatedPlayer))
              .catch(err => errorLog.error(err));
          case 2:
            return this.luckEvent(selectedPlayer)
              .then(updatedPlayer => this.Database.savePlayer(updatedPlayer))
              .catch(err => errorLog.error(err));
        }
      })
      .then((updatedPlayer) => {
        if (updatedPlayer.events % 100 === 0 && updatedPlayer.events !== 0) {
          this.Helper.sendMessage(this.discordHook, twitchBot, updatedPlayer, false, this.Helper.setImportantMessage(`${updatedPlayer.name} has encountered ${updatedPlayer.events} events!`))
            .then(this.Helper.sendPrivateMessage(this.discordHook, updatedPlayer, `You have encountered ${updatedPlayer.events} events!`, true));
        }
        return updatedPlayer;
      })
      .then((updatedPlayer) => {
        this.setPlayerTitles(discordBot, updatedPlayer);
      });
  }

  moveEvent(selectedPlayer, onlinePlayers) {
    return new Promise((resolve) => {
      if (!this.Event.MapClass.getTowns().includes(selectedPlayer.map.name)) {
        return this.attackEvent(selectedPlayer, onlinePlayers)
          .then(updatedPlayer => resolve(updatedPlayer));
      }

      return this.Event.moveEvent(selectedPlayer)
        .then(updatedPlayer => resolve(updatedPlayer));
    });
  }

  /**
   * Rolls dice to select which type of attack event is activated for the player
   * @param {Player} selectedPlayer
   * @param {Array} onlinePlayers
   */
  attackEvent(selectedPlayer, onlinePlayers) {
    return new Promise((resolve) => {
      const luckDice = this.Helper.randomBetween(0, 100);
      if (this.Event.MapClass.getTowns().includes(selectedPlayer.map.name) && luckDice <= 30 + (selectedPlayer.stats.luk / 4)) {
        return this.Event.sellInTown(selectedPlayer)
          .then(updatedPlayer => this.Event.generateTownItemEvent(updatedPlayer))
          .then(updatedPlayer => resolve(updatedPlayer));
      }

      if (luckDice >= 95 - (selectedPlayer.stats.luk / 4) && !this.Event.MapClass.getTowns().includes(selectedPlayer.map.name)
        && selectedPlayer.health > (100 + (selectedPlayer.level * 5)) / 4) {
        return this.Event.attackEventPlayerVsPlayer(selectedPlayer, onlinePlayers, (this.config.multiplier + selectedPlayer.personalMultiplier))
          .then(updatedPlayer => resolve(updatedPlayer));
      }

      if (!this.Event.MapClass.getTowns().includes(selectedPlayer.map.name)) {
        if (selectedPlayer.health > (100 + (selectedPlayer.level * 5)) / 4) {
          return this.Event.attackEventMob(selectedPlayer, (this.config.multiplier + selectedPlayer.personalMultiplier))
            .then(updatedPlayer => resolve(updatedPlayer));
        }

        return this.Event.campEvent(selectedPlayer)
          .then(updatedPlayer => resolve(updatedPlayer));
      }

      return this.Event.generateLuckItemEvent(selectedPlayer)
        .then(updatedPlayer => resolve(updatedPlayer));
    });
  }

  /**
   * Rolls dice to select which type of luck event is activated for the player
   * @param {Player} selectedPlayer
   */
  luckEvent(selectedPlayer) {
    return new Promise((resolve) => {
      const luckDice = this.Helper.randomBetween(0, 100);
      if (luckDice <= 5 + (selectedPlayer.stats.luk / 4)) {
        return this.Event.generateGodsEvent(selectedPlayer)
          .then(updatedPlayer => resolve(updatedPlayer));
      }

      if (this.Event.MapClass.getTowns().includes(selectedPlayer.map.name)) {
        if (luckDice <= 20 + (selectedPlayer.stats.luk / 4)) {
          return this.Event.generateGamblingEvent(selectedPlayer)
            .then(updatedPlayer => resolve(updatedPlayer));
        } else if (luckDice <= 5 + (selectedPlayer.stats.luk / 4) && selectedPlayer.quest.questMob === 'None') {
          return this.Event.generateQuestEvent(selectedPlayer)
            .then(updatedPlayer => resolve(updatedPlayer));
        }
      }

      if (this.Event.isBlizzardActive && this.Event.MapClass.getMapsByType('Snow').includes(selectedPlayer.map.name) && luckDice <= 35 + (selectedPlayer.stats.luk / 4)) {
        return this.Event.chanceToCatchSnowflake(selectedPlayer)
          .then(updatedPlayer => resolve(updatedPlayer));
      }

      if (luckDice >= 65 - (selectedPlayer.stats.luk / 4)) {
        return this.Event.generateLuckItemEvent(selectedPlayer)
          .then(updatedPlayer => resolve(updatedPlayer));
      }

      return this.Event.generateGoldEvent(selectedPlayer, (this.config.multiplier + selectedPlayer.personalMultiplier))
        .then(updatedPlayer => resolve(updatedPlayer));
    });
  }

  // Event
  powerHourBegin() {
    this.Helper.sendMessage(this.discordHook, 'twitch', undefined, false, this.Helper.setImportantMessage('Dark clouds are gathering in the sky. Something is about to happen...'));

    setTimeout(() => {
      this.Helper.sendMessage(this.discordHook, 'twitch', undefined, false, this.Helper.setImportantMessage('You suddenly feel energy building up within the sky, the clouds get darker, you hear monsters screeching nearby! Power Hour has begun!'));
      this.config.multiplier += 1;
    }, 1800000); // 30 minutes

    setTimeout(() => {
      this.Helper.sendMessage(this.discordHook, 'twitch', undefined, false, this.Helper.setImportantMessage('The clouds are disappearing, soothing wind brushes upon your face. Power Hour has ended!'));
      this.config.multiplier -= 1;
      this.config.multiplier = this.config.multiplier <= 0 ? 1 : this.config.multiplier;
    }, 5400000); // 1hr 30 minutes
  }

  /**
   * Gives gold amount to player
   * @param {Number} playerId
   * @param {Number} amount
   */
  giveGold(playerId, amount) {
    return this.Database.loadPlayer(playerId, { pastEvents: 0, pastPvpEvents: 0 })
      .then((updatingPlayer) => {
        updatingPlayer.gold.current += Number(amount);
        updatingPlayer.gold.total += Number(amount);
        this.Database.savePlayer(updatingPlayer);
      });
  }

  /**
   * Returns top10 of a certain attribute
   * @param {Number} commandAuthor
   * @param {String} type
   */
  top10(commandAuthor, type = { level: -1 }) {
    return this.Database.loadTop10(type)
      .then((top10) => {
        const rankString = `${top10.filter(player => Object.keys(type)[0].includes('.') ? player[Object.keys(type)[0].split('.')[0]][Object.keys(type)[0].split('.')[1]] : player[Object.keys(type)[0]] > 0)
          .sort((player1, player2) => {
            if (Object.keys(type)[0] === 'level') {
              return player2.experience.current - player1.experience.current && player2.level - player1.level;
            }

            if (Object.keys(type)[0].includes('.')) {
              const keys = Object.keys(type)[0].split('.');
              return player2[keys[0]][keys[1]] - player1[keys[0]][keys[1]];
            }

            return player2[Object.keys(type)[0]] - player1[Object.keys(type)[0]];
          })
          .map((player, rank) => `Rank ${rank + 1}: ${player.name} - ${Object.keys(type)[0].includes('.') ? `${Object.keys(type)[0].split('.')[0]}: ${player[Object.keys(type)[0].split('.')[0]][Object.keys(type)[0].split('.')[1]]}` : `${Object.keys(type)[0].replace('currentBounty', 'Bounty')}: ${player[Object.keys(type)[0]]}`}`)
          .join('\n')}`;

        commandAuthor.send(`\`\`\`Top 10 ${Object.keys(type)[0].includes('.') ? `${Object.keys(type)[0].split('.')[0]}` : `${Object.keys(type)[0].replace('currentBounty', 'Bounty')}`}:
${rankString}
        \`\`\``);
      });
  }

  getRank(commandAuthor, type = { level: -1 }) {
    return this.Database.loadPlayer(commandAuthor.id, { pastEvents: 0, pastPvpEvents: 0 })
      .then(player => this.Database.loadCurrentRank(player, type))
      .then(currentRank => currentRank.filter(player => Object.keys(type)[0].includes('.') ? player[Object.keys(type)[0].split('.')[0]][Object.keys(type)[0].split('.')[1]] : player[Object.keys(type)[0]] > 0)
        .sort((player1, player2) => {
          if (Object.keys(type)[0] === 'level') {
            return player2.experience.current - player1.experience.current && player2.level - player1.level;
          }

          if (Object.keys(type)[0].includes('.')) {
            const keys = Object.keys(type)[0].split('.');
            return player2[keys[0]][keys[1]] - player1[keys[0]][keys[1]];
          }

          return player2[Object.keys(type)[0]] - player1[Object.keys(type)[0]];
        }).findIndex(player => player.discordId === commandAuthor.id))
      .then((rank) => {
        commandAuthor.send(`You're currently ranked ${rank + 1} in ${Object.keys(type)[0].includes('.') ? Object.keys(type)[0].split('.')[0] : Object.keys(type)[0]}!`);
      });
  }

  /**
   * Modify player preference for being @mentionned in events
   * @param {Number} commandAuthor
   * @param {Boolean} isMentionInDiscord
   */
  modifyMention(commandAuthor, isMentionInDiscord) {
    return this.Database.loadPlayer(commandAuthor.id, { pastEvents: 0, pastPvpEvents: 0 })
      .then((castingPlayer) => {
        if (!castingPlayer) {
          return commandAuthor.send('Please set this after you have been born');
        }

        if (castingPlayer.isMentionInDiscord !== isMentionInDiscord) {
          castingPlayer.isMentionInDiscord = isMentionInDiscord;

          return this.Database.savePlayer(castingPlayer)
            .then(() => commandAuthor.send('Preference for being @mention has been updated.'));
        }

        return commandAuthor.send('Your @mention preference is already set to this value.');
      });
  }

  /**
   * Modify player preference for being private messaged in events
   * @param {Number} commandAuthor
   * @param {Boolean} isMentionInDiscord
   */
  modifyPM(commandAuthor, isPrivateMessage, filtered) {
    return this.Database.loadPlayer(commandAuthor.id, { pastEvents: 0, pastPvpEvents: 0 })
      .then((castingPlayer) => {
        if (!castingPlayer) {
          return commandAuthor.send('Please set this after you have been born');
        }

        if (castingPlayer.isPrivateMessage !== isPrivateMessage || castingPlayer.isPrivateMessageImportant !== filtered) {
          castingPlayer.isPrivateMessage = isPrivateMessage;
          castingPlayer.isPrivateMessageImportant = filtered;

          return this.Database.savePlayer(castingPlayer)
            .then(() => commandAuthor.send('Preference for being PMed has been updated.'));
        }

        return commandAuthor.send('Your PM preference is already set to this value.');
      });
  }

  /**
   * Modify player gender
   * @param Player commandAuthor
   * @param String gender
   */
  modifyGender(commandAuthor, gender) {
    return this.Database.loadPlayer(commandAuthor.id, { pastEvents: 0, pastPvpEvents: 0 })
      .then((castingPlayer) => {
        if (!castingPlayer) {
          return commandAuthor.send('Please set this after you have been born');
        }

        if (castingPlayer.gender !== gender) {
          castingPlayer.gender = gender;
          return this.Database.savePlayer(castingPlayer)
            .then(() => commandAuthor.send('Gender has been updated.'));
        }

        return commandAuthor.send('Your gender is already set to this value.');
      });
  }

  /**
   * Casts spell
   * @param {Number} commandAuthor
   * @param {String} spell
   */
  castSpell(commandAuthor, spell) {
    return this.Database.loadPlayer(commandAuthor.id, { pastEvents: 0, pastPvpEvents: 0 })
      .then((castingPlayer) => {
        switch (spell) {
          case 'bless':
            if (castingPlayer.gold.current >= globalSpells.bless.spellCost) {
              castingPlayer.spellCast++;
              castingPlayer.gold.current -= globalSpells.bless.spellCost;
              this.Database.savePlayer(castingPlayer)
                .then(() => {
                  commandAuthor.send('Spell has been casted!');
                })
                .then(() => this.Database.updateGame(this.config));
              this.config.multiplier += 1;

              this.config.spells.activeBless++;

              this.discordHook.actionHook.send(this.Helper.setImportantMessage(`${castingPlayer.name} just casted ${spell}!!\nCurrent Active Bless: ${this.config.spells.activeBless}\nCurrent Multiplier is: ${this.config.multiplier}x`));
              setTimeout(() => {
                this.config.multiplier -= 1;
                this.config.multiplier = this.config.multiplier <= 0 ? 1 : this.config.multiplier;
                this.config.spells.activeBless--;
                this.Database.updateGame(this.config);

                this.discordHook.actionHook.send(this.Helper.setImportantMessage(`${castingPlayer.name}s ${spell} just wore off.\nCurrent Active Bless: ${this.config.spells.activeBless}\nCurrent Multiplier is: ${this.config.multiplier}x`));
              }, 1800000); // 30 minutes
            } else {
              commandAuthor.send(`You do not have enough gold! This spell costs ${globalSpells.bless.spellCost} gold. You are lacking ${globalSpells.bless.spellCost - castingPlayer.gold.current} gold.`);
            }
            break;

          case 'home':
            if (castingPlayer.gold.current >= globalSpells.home.spellCost) {
              castingPlayer.gold.current -= globalSpells.home.spellCost;
              const Kindale = this.Event.MapClass.getMapByIndex(4);
              castingPlayer.map = Kindale;
              this.discordHook.actionHook.send(`${castingPlayer.name} just casted ${spell}!\nTeleported back to ${Kindale.name}.`);

              this.Database.savePlayer(castingPlayer)
                .then(() => {
                  commandAuthor.send('Spell has been casted!');
                });
            } else {
              commandAuthor.send(`You do not have enough gold! This spell costs ${globalSpells.home.spellCost} gold. You are lacking ${globalSpells.home.spellCost - castingPlayer.gold.current} gold.`);
            }
            break;
        }
      });
  }

  /**
   * Sets player bounty
   * @param {Number} recipient
   * @param {Number} amount
   */
  setPlayerBounty(recipient, amount) {
    return this.Database.loadPlayer(recipient, { pastEvents: 0, pastPvpEvents: 0 })
      .then((player) => {
        player.currentBounty = amount;
        return this.Database.savePlayer(player);
      });
  }

  /**
   * Sets player gold
   * @param {Number} recipient
   * @param {Number} amount
   */
  setPlayerGold(recipient, amount) {
    return this.Database.loadPlayer(recipient, { pastEvents: 0, pastPvpEvents: 0 })
      .then((player) => {
        player.gold.current = Number(amount);
        player.gold.total += Number(amount);
        return this.Database.savePlayer(player);
      });
  }

  joinLottery(discordUser) {
    return this.Database.loadPlayer(discordUser.id, { pastEvents: 0, pastPvpEvents: 0 })
      .then((player) => {
        if (player.lottery.joined) {
          return 'You\'ve already joined todays daily lottery!';
        }
        player.lottery.joined = true;
        player.lottery.amount += 100;

        return this.Database.loadGame()
          .then((updatedConfig) => {
            updatedConfig.dailyLottery.prizePool += 100;
            this.config = updatedConfig;

            return this.Database.updateGame(updatedConfig)
              .then(() => this.Database.savePlayer(player))
              .then(() => 'You have joined todays daily lottery! Good luck!')
              .catch(err => errorLog.error(err));
          })
          .catch(err => errorLog.error(err));
      });
  }

  prizePool() {
    return this.Database.loadLotteryPlayers()
      .then((lotteryPlayers) => {
        return `There are ${lotteryPlayers.length} contestants for a prize pool of ${this.config.dailyLottery.prizePool} gold!`;
      });
  }

  dailyLottery(discordBot) {
    if (!process.env.NODE_ENV.includes('production')) {
      return;
    }

    return this.Database.loadLotteryPlayers()
      .then((lotteryPlayers) => {
        if (!lotteryPlayers.length) {
          return;
        }

        const randomWinner = this.Helper.randomBetween(0, lotteryPlayers.length - 1);
        const winner = lotteryPlayers[randomWinner];

        return this.Database.loadGame()
          .then((updatedConfig) => {
            const eventMsg = this.Helper.setImportantMessage(`Out of ${lotteryPlayers.length} contestants, ${winner.name} has won the daily lottery of ${updatedConfig.dailyLottery.prizePool} gold!`);
            const eventLog = `Congratulations! Out of ${lotteryPlayers.length} contestants, you just won ${updatedConfig.dailyLottery.prizePool} gold from the daily lottery!`;
            winner.gold.current += updatedConfig.dailyLottery.prizePool;
            winner.gold.total += updatedConfig.dailyLottery.prizePool;
            winner.gold.dailyLottery += updatedConfig.dailyLottery.prizePool;

            lotteryPlayers.forEach((player) => {
              const discordUser = discordBot.users.find(user => user.id === player.discordId);
              if (player.discordId !== winner.discordId && discordUser) {
                discordUser.send(`Thank you for participating in the lottery! Unfortunately ${winner.name} has won the prize of ${updatedConfig.dailyLottery.prizePool} out of ${lotteryPlayers.length} people.`);
              } else if (discordUser) {
                discordUser.send(`Thank you for participating in the lottery! You have won the prize of ${updatedConfig.dailyLottery.prizePool} out of ${lotteryPlayers.length} people.`);
              }
            });

            updatedConfig.dailyLottery.prizePool = this.Helper.randomBetween(1500, 10000);
            this.config = updatedConfig;

            return Promise.all([
              this.Database.updateGame(updatedConfig),
              this.Helper.sendMessage(this.discordHook, 'twitch', winner, false, eventMsg),
              this.Helper.logEvent(winner, this.Database, eventLog, 'ACTION'),
              this.Database.savePlayer(winner),
              this.Database.removeLotteryPlayers()
            ])
              .catch(err => errorLog.error(err));
          });
      })
      .catch(err => errorLog.error(err));
  }

  setPlayerTitles(discordBot, selectedPlayer) {
    if (enumHelper.roamingNpcs.filter(npc => npc.discordId === selectedPlayer.discordId).length > 0
      || enumHelper.mockPlayers.filter(mock => mock.discordId === selectedPlayer.discordId).length > 0) {
      return selectedPlayer;
    }

    const currentGuild = discordBot.guilds.array()[0];
    const playerDiscordObj = currentGuild.members
      .filterArray(member => member.id === selectedPlayer.discordId)[0];
    const goldTitleRole = currentGuild.roles.filterArray(role => role.name === 'Gold Hoarder')[0];
    const thiefTitleRole = currentGuild.roles.filterArray(role => role.name === 'Thief')[0];
    const veteranTitleRole = currentGuild.roles.filterArray(role => role.name === 'Veteran Idler')[0];
    const blesserTitleRole = currentGuild.roles.filterArray(role => role.name === 'Blesser')[0];

    const hasGoldTitle = playerDiscordObj.roles.array().includes(goldTitleRole);
    if (selectedPlayer.gold.current >= 50000 && !hasGoldTitle) {
      playerDiscordObj.addRole(goldTitleRole);
      this.discordHook.actionHook.send(this.Helper.setImportantMessage(`${selectedPlayer.name} has just earned the Gold Hoarder title!`));
    } else if (selectedPlayer.gold.current < 50000 && hasGoldTitle) {
      playerDiscordObj.removeRole(goldTitleRole);
      this.discordHook.actionHook.send(this.Helper.setImportantMessage(`${selectedPlayer.name} lost the Gold Hoarder title!`));
    }

    const hasThiefTitle = playerDiscordObj.roles.array().includes(thiefTitleRole);
    if (selectedPlayer.stole >= 50 && !hasThiefTitle) {
      playerDiscordObj.addRole(thiefTitleRole);
      this.discordHook.actionHook.send(this.Helper.setImportantMessage(`${selectedPlayer.name} has just earned the Thief title!`));
    } else if (selectedPlayer.stole < 50 && hasThiefTitle) {
      playerDiscordObj.removeRole(thiefTitleRole);
      this.discordHook.actionHook.send(this.Helper.setImportantMessage(`${selectedPlayer.name} lost the Thief title!`));
    }

    const hasVeteranTitle = playerDiscordObj.roles.array().includes(veteranTitleRole);
    if (selectedPlayer.events >= 10000 && !hasVeteranTitle) {
      playerDiscordObj.addRole(veteranTitleRole);
      this.discordHook.actionHook.send(this.Helper.setImportantMessage(`${selectedPlayer.name} has just earned the Veteran Idler title!`));
    } else if (selectedPlayer.events < 10000 && hasVeteranTitle) {
      playerDiscordObj.removeRole(veteranTitleRole);
      this.discordHook.actionHook.send(this.Helper.setImportantMessage(`${selectedPlayer.name} lost the Veteran Idler title!`));
    }

    const hasBlesserTitle = playerDiscordObj.roles.array().includes(blesserTitleRole);
    if (selectedPlayer.spellCast >= 50 && !hasBlesserTitle) {
      playerDiscordObj.addRole(blesserTitleRole);
      this.discordHook.actionHook.send(this.Helper.setImportantMessage(`${selectedPlayer.name} has just earned the Blesser title!`));
    } else if (selectedPlayer.spellCast < 50 && hasBlesserTitle) {
      playerDiscordObj.removeRole(blesserTitleRole);
      this.discordHook.actionHook.send(this.Helper.setImportantMessage(`${selectedPlayer.name} lost the Blesser title!`));
    }
  }

  /**
   * places a bounty on specific player
   * @param {Number} playerId
   * @param {Number} recipient
   * @param {Number} amount
   */
  placeBounty(bountyPlacer, recipient, amount) {
    return this.Database.loadPlayer(bountyPlacer.id, { pastEvents: 0, pastPvpEvents: 0 })
      .then((placer) => {
        if (placer.gold.current >= amount) {
          placer.gold.current -= amount;

          return this.Database.savePlayer(placer)
            .then(() => {
              return this.Database.loadPlayer(recipient)
                .then((bountyRecipient) => {
                  if (!bountyRecipient) {
                    return bountyPlacer.send('This player does not exist.');
                  }
                  bountyRecipient.currentBounty += amount;
                  this.discordHook.actionHook.send(this.Helper.setImportantMessage(`${placer.name} just put a bounty of ${amount} gold on ${bountyRecipient.name}'s head!`));

                  return this.Database.savePlayer(bountyRecipient)
                    .then(() => bountyPlacer.send(`Bounty of ${amount} gold has been placed`));
                });
            });
        }

        return bountyPlacer.send('You need more gold to place this bounty');
      });
  }

  /**
   * Returns player eventlog by <count> amount
   * @param {String} playerId
   * @param {Number} count
   */
  playerEventLog(playerId, count) {
    return this.Database.loadActionLog(playerId)
      .then((playerLog) => {
        if (!playerLog.log.length) {
          return;
        }

        return this.Helper.generateLog(playerLog, count);
      });
  }

  /**
   * Returns player pvp event log by <count> amount
   * @param {String} playerId
   * @param {Number} count
   */
  playerPvpLog(playerId, count) {
    return this.Database.loadPvpLog(playerId)
      .then((player) => {
        if (!player) {
          return;
        }

        return this.Helper.generatePvpLog(player, count);
      });
  }

  /**
   * Loads player stats by discordId
   * @param {Number} commandAuthor
   */
  playerStats(commandAuthor) {
    return this.Database.loadPlayer(commandAuthor.id, enumHelper.statsSelectFields);
  }

  /**
   * Loads player inventory by discordId
   * @param {Number} commandAuthor
   */
  playerInventory(commandAuthor) {
    return this.Database.loadPlayer(commandAuthor.id, enumHelper.inventorySelectFields);
  }

  /**
   * Loads player equipment by discordId
   * @param {Number} commandAuthor
   */
  playerEquipment(commandAuthor) {
    return this.Database.loadPlayer(commandAuthor.id, enumHelper.equipSelectFields);
  }

  /**
   * Get online players maps by an array of discordIds
   * @param {Array} onlinePlayers
   */
  getOnlinePlayerMaps(onlinePlayers) {
    return this.Database.loadOnlinePlayerMaps(onlinePlayers);
  }

  /**
   * Saves player into database
   * @param {Number} player
   */
  savePlayer(player) {
    return this.Database.savePlayer(player);
  }

  /**
   * Loads player by discordId
   * @param {Number} playerId
   */
  loadPlayer(playerId) {
    return this.Database.loadPlayer(playerId);
  }

  /**
   * Deletes player by discordId
   * @param {Number} playerId
   */
  deletePlayer(playerId) {
    return this.Database.deletePlayer(playerId);
  }

  /**
   * Deletes all players in database
   */
  deleteAllPlayers() {
    return this.Database.resetAllPlayers();
  }

  /**
   * SPECIAL EVENTS
   */
  blizzardSwitch(blizzardSwitch) {
    return this.Event.blizzardSwitch(this.discordHook, blizzardSwitch);
  }

  /**
   * Sends Christmas Pre Event Message and another pre event message after 21 hours
   */
  sendChristmasFirstPreEventMessage() {
    return this.Helper.sendMessage(this.discordHook, 'twitch', undefined, false, '@everyone\`\`\`python\n\'Terrible news from Kingdom of Olohaseth! Several people are now in hospitals with unknown wounds. They don\`t remember exactly what or who did it to them but they keep warning not to travel to other lands...\'\`\`\`');
  }

  sendChristmasSecondPreEventMessage() {
    return this.Helper.sendMessage(this.discordHook, 'twitch', undefined, false, '@everyone\`\`\`python\n\'Rumour has it that some mysterious beasts appeared in Wintermere, Norpond and North Redmount. Inns and taverns all over the world are full of curious adventurers. Is it somehow connected with recent news from Olohaseth?\'\`\`\`');
  }

  // TODO change to utilize setTimeout
  /**
   * Activates christmas mobs to be spawnable and items droppable
   * @param {*} isStarting
   */
  updateChristmasEvent(isStarting) {
    if (isStarting) {
      this.Helper.sendMessage(this.discordHook, 'twitch', undefined, false, '@everyone\`\`\`python\n\'The bravest adventurers started their expedition to the northern regions and discovered unbelievable things. It seems that Yetis had awoken from their snow caves after hundreds of years of sleep. Are they not a myth anymore?\'\`\`\`');
      this.Event.MonsterClass.monsters.forEach((mob) => {
        if (mob.isXmasEvent) {
          mob.isSpawnable = true;
        }
      });
      this.Event.ItemClass.items.forEach((type) => {
        type.forEach((item) => {
          if (item.isXmasEvent && item.name !== 'Snowflake') {
            item.isDroppable = true;
          }
        });
      });
      return '';
    }

    this.Helper.sendMessage(this.discordHook, 'twitch', undefined, false, '@everyone\`\`\`python\n\'Thousand of townsmen in Olohaseth, Kindale and other towns are celebrating end of the Darknight. It seems that Christmas Gnomes lost all their candy canes and all Yetis are back to their caves. Though noone knows for how long...\'\`\`\`');
    this.Event.MonsterClass.monsters.forEach((mob) => {
      if (mob.isXmasEvent) {
        mob.isSpawnable = false;
      }
    });
    this.Event.ItemClass.items.forEach((type) => {
      type.forEach((item) => {
        if (item.isXmasEvent && item.name !== 'Snowflake') {
          item.isDroppable = false;
        }
      });
    });
    return '';
  }

}

module.exports = Game;
