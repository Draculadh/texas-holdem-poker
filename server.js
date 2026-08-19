const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

// ==================== 牌组工具 ====================
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VAL = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};
const HAND_NAMES = ['高牌','一对','两对','三条','顺子','同花','葫芦','四条','同花顺','皇家同花顺'];
const PHASES = ['翻牌前','翻牌','转牌','河牌','摊牌'];

function createDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({rank:r, suit:s});
  return deck;
}
function shuffle(deck) {
  for (let i = deck.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [deck[i],deck[j]] = [deck[j],deck[i]];
  }
  return deck;
}

function getCombinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  const withFirst = getCombinations(rest, k-1).map(c => [first, ...c]);
  const without = getCombinations(rest, k);
  return [...withFirst, ...without];
}

function evaluate5(cards) {
  const vals = cards.map(c => RANK_VAL[c.rank]).sort((a,b) => b-a);
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);
  let isStraight = true;
  for (let i = 1; i < 5; i++) { if (vals[i] !== vals[i-1]-1) { isStraight = false; break; } }
  // A-low straight
  if (!isStraight && vals[0]===14 && vals[1]===5 && vals[2]===4 && vals[3]===3 && vals[4]===2) {
    isStraight = true; vals.splice(0,1); vals.push(1);
  }
  const counts = {};
  vals.forEach(v => counts[v] = (counts[v]||0)+1);
  const groups = Object.entries(counts).map(([v,c]) => [parseInt(v),c]).sort((a,b) => b[1]-a[1] || b[0]-a[0]);

  if (isStraight && isFlush) {
    if (vals[0] === 14) return {rank:9, name:HAND_NAMES[9], kickers:vals};
    return {rank:8, name:HAND_NAMES[8], kickers:vals};
  }
  if (groups[0][1] === 4) return {rank:7, name:HAND_NAMES[7], kickers:[groups[0][0],groups[1][0]]};
  if (groups[0][1] === 3 && groups[1][1] === 2) return {rank:6, name:HAND_NAMES[6], kickers:[groups[0][0],groups[1][0]]};
  if (isFlush) return {rank:5, name:HAND_NAMES[5], kickers:vals};
  if (isStraight) return {rank:4, name:HAND_NAMES[4], kickers:vals};
  if (groups[0][1] === 3) return {rank:3, name:HAND_NAMES[3], kickers:[groups[0][0],groups[1][0],groups[2][0]]};
  if (groups[0][1] === 2 && groups[1][1] === 2) return {rank:2, name:HAND_NAMES[2], kickers:[groups[0][0],groups[1][0],groups[2][0]]};
  if (groups[0][1] === 2) return {rank:1, name:HAND_NAMES[1], kickers:[groups[0][0],groups[1][0],groups[2][0],groups[3][0]]};
  return {rank:0, name:HAND_NAMES[0], kickers:vals};
}

function getBestHand(cards) {
  if (cards.length < 5) return {rank:0, name:'不够5张', kickers:[]};
  const combos = getCombinations(cards, 5);
  let best = null;
  for (const combo of combos) {
    const h = evaluate5(combo);
    if (!best || compareHands(h, best) > 0) best = h;
  }
  return best;
}

function compareHands(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < Math.max(a.kickers.length, b.kickers.length); i++) {
    const av = a.kickers[i] || 0;
    const bv = b.kickers[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function calculateSidePots(players) {
  const sorted = [...players].filter(p => p.totalBet > 0).sort((a,b) => a.totalBet - b.totalBet);
  const pots = [];
  let prevBet = 0;
  for (let i = 0; i < sorted.length; i++) {
    const level = sorted[i].totalBet - prevBet;
    if (level <= 0) continue;
    let amount = level * (sorted.length - i);
    // 从已弃牌玩家的投注中扣除
    const folded = sorted.filter((p,j) => j < i && p.folded);
    folded.forEach(p => { /* already counted */ });
    const eligible = sorted.slice(i).filter(p => !p.folded);
    // 加上弃牌玩家的投注
    sorted.forEach((p,j) => { if (j < i && p.folded) amount += level; });
    if (amount > 0) pots.push({ amount, eligible });
    prevBet = sorted[i].totalBet;
  }
  return pots.length > 0 ? pots : [{amount:0, eligible:[]}];
}

// ==================== AI 决策 ====================
const AI_NAMES = ['老王','阿杰','小美','大刘','阿强','小林'];
const AI_AVATARS = ['👨','👩','🧔','👱','🧑','👨‍🦰'];

function preflopStrength(hand) {
  const [c1, c2] = hand;
  const v1 = RANK_VAL[c1.rank], v2 = RANK_VAL[c2.rank];
  const hi = Math.max(v1, v2), lo = Math.min(v1, v2);
  const suited = c1.suit === c2.suit;
  const pair = v1 === v2;
  let s = 0;
  if (pair) {
    if (hi >= 13) s = 0.92;
    else if (hi >= 11) s = 0.85;
    else if (hi >= 8) s = 0.72;
    else if (hi >= 5) s = 0.55;
    else s = 0.42;
  } else {
    if (hi === 14) {
      if (lo >= 12) s = 0.78;
      else if (lo >= 10) s = 0.68;
      else if (lo >= 8) s = 0.55;
      else if (suited) s = 0.48;
      else s = 0.38;
    } else if (hi === 13) {
      if (lo >= 11) s = 0.70;
      else if (lo >= 9) s = 0.58;
      else if (suited) s = 0.45;
      else s = 0.35;
    } else if (hi === 12) {
      if (lo >= 10) s = 0.62;
      else if (suited) s = 0.40;
      else s = 0.32;
    } else if (hi >= 10 && lo >= 9) {
      s = suited ? 0.52 : 0.42;
    } else if (suited && hi - lo <= 4) {
      s = 0.38;
    } else {
      s = 0.25;
    }
  }
  return s;
}

function detectDraws(hand, community) {
  const all = [...hand, ...community];
  const suitCounts = {};
  all.forEach(c => suitCounts[c.suit] = (suitCounts[c.suit]||0)+1);
  const maxSuit = Math.max(...Object.values(suitCounts));
  const flushDraw = maxSuit === 4;

  const vals = [...new Set(all.map(c => RANK_VAL[c.rank]))].sort((a,b) => a-b);
  let straightDraw = false, openEnded = false;
  for (let i = 0; i < vals.length - 2; i++) {
    if (vals[i+2] - vals[i] === 2) straightDraw = true;
    if (i < vals.length - 3 && vals[i+3] - vals[i] === 3) openEnded = true;
  }
  return { flushDraw, straightDraw, openEnded };
}

function aiDecide(player, game) {
  const diff = player.difficulty || 'normal';
  const aggression = player.aggression || 0.55;
  const bluffRate = player.bluffRate || 0.10;

  const activePlayers = game.players.filter(p => !p.folded);
  const maxBet = Math.max(...activePlayers.map(p => p.bet));
  const toCall = maxBet - player.bet;
  const potOdds = toCall > 0 ? toCall / (game.pot + toCall) : 0;

  let strength = 0;
  if (game.community.length === 0) {
    strength = preflopStrength(player.hand);
  } else {
    const best = getBestHand([...player.hand, ...game.community]);
    const rankMap = [0.15,0.30,0.45,0.58,0.68,0.75,0.85,0.92,0.97,0.99];
    strength = rankMap[best.rank] || 0.3;
    const draws = detectDraws(player.hand, game.community);
    if (draws.flushDraw) strength += 0.15;
    if (draws.openEnded) strength += 0.12;
    else if (draws.straightDraw) strength += 0.06;
  }

  if (diff === 'easy') strength += (Math.random()-0.5)*0.30;
  else if (diff === 'normal') strength += (Math.random()-0.5)*0.12;

  strength = Math.max(0.05, Math.min(0.99, strength));
  const playerCount = activePlayers.length;
  strength *= (1 - (playerCount-2)*0.06);

  const callEv = strength * (game.pot + toCall) - (1-strength) * toCall;
  const bluffing = Math.random() < bluffRate && game.community.length >= 3;
  const position = (game.dealerIdx + activePlayers.indexOf(player)) % activePlayers.length;
  const isLatePos = position >= activePlayers.length - 2;

  // 检测全压
  const someoneAllIn = game.players.some(p => !p.folded && p.allIn && p.bet === maxBet);
  const isFacingAllIn = someoneAllIn && toCall >= player.chips * 0.5;
  if (isFacingAllIn) {
    let callEquity = strength;
    if (game.community.length === 0) callEquity = Math.max(callEquity, 0.45);
    else callEquity = Math.max(callEquity, strength * 0.9 + 0.1);
    if (diff === 'easy') callEquity += (Math.random()-0.5)*0.25;
    if (callEquity >= potOdds - 0.05) return {type:'call'};
    if (callEquity > 0.35 && potOdds < 0.5 && Math.random() < 0.5) return {type:'call'};
    if (diff === 'easy' && Math.random() < 0.4) return {type:'call'};
    return {type:'fold'};
  }

  if (toCall === 0) {
    if (strength > 0.75 && Math.random() < aggression) {
      const raise = Math.floor(game.pot * (0.5 + Math.random()*0.5));
      return {type:'raise', amount: Math.min(player.bet + raise, player.bet + player.chips)};
    }
    if (strength > 0.55 && isLatePos && Math.random() < aggression * 0.6) {
      const raise = Math.floor(game.pot * 0.4);
      return {type:'raise', amount: Math.min(player.bet + raise, player.bet + player.chips)};
    }
    if (bluffing && Math.random() < 0.5) {
      const raise = Math.floor(game.pot * 0.5);
      return {type:'raise', amount: Math.min(player.bet + raise, player.bet + player.chips)};
    }
    return {type:'check'};
  }

  if (strength < 0.20 && !bluffing) {
    if (toCall < player.chips * 0.03 && Math.random() < 0.3) return {type:'call'};
    return {type:'fold'};
  }
  if (strength < 0.40) {
    if (bluffing && toCall < player.chips * 0.15 && Math.random() < 0.5) {
      const raise = Math.floor(game.pot * 0.6);
      return {type:'raise', amount: Math.min(maxBet + raise, player.bet + player.chips)};
    }
    if (callEv > -toCall * 0.3) return {type:'call'};
    return {type:'fold'};
  }
  if (strength < 0.65) {
    if (toCall > player.chips * 0.5) {
      if (strength > 0.55) return {type:'call'};
      return {type:'fold'};
    }
    if (Math.random() < aggression * 0.4) {
      const raise = Math.floor(game.pot * (0.3 + Math.random()*0.3));
      return {type:'raise', amount: Math.min(maxBet + raise, player.bet + player.chips)};
    }
    return {type:'call'};
  }

  // 强牌
  if (strength > 0.85 && Math.random() < 0.3) return {type:'call'};
  const raiseMult = strength > 0.9 ? 0.8 : 0.6;
  const raise = Math.floor(game.pot * raiseMult);
  return {type:'raise', amount: Math.min(maxBet + raise, player.bet + player.chips)};
}

// ==================== 房间管理 ====================
const rooms = {};

function createRoom(hostName, totalRounds, difficulty, fillAI) {
  const code = Math.random().toString(36).substr(2, 4).toUpperCase();
  const room = {
    code,
    players: [],
    deck: [],
    community: [],
    pot: 0,
    currentBet: 0,
    minRaise: 20,
    smallBlind: 10,
    bigBlind: 20,
    dealerIdx: -1,
    curPlayerIdx: 0,
    phase: 0,
    roundNum: 0,
    totalRounds: totalRounds || 15,
    difficulty: difficulty || 'normal',
    fillAI: fillAI !== false,
    state: 'waiting', // waiting, dealing, betting, result, ended
    hostName,
    handStartChips: [],
    lastRaiserIdx: -1,
    aiCount: 0,
    timer: null,
    phaseTimer: null
  };
  rooms[code] = room;
  return room;
}

function broadcast(room, msg, excludeWs) {
  room.players.forEach(p => {
    if (p.ws && p.ws !== excludeWs && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify(msg));
    }
  });
}

function broadcastState(room) {
  const publicPlayers = room.players.map((p, idx) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    chips: p.chips,
    bet: p.bet,
    folded: p.folded,
    allIn: p.allIn,
    isAI: p.isAI,
    isHost: p.isHost,
    connected: !!p.ws || p.isAI,
    hand: (p.isAI || !p.folded) && room.state === 'result' ? p.hand : (p.hand ? (p.hand.length > 0 ? ['back','back'] : []) : []),
    handRevealed: room.state === 'result' && !p.folded
  }));

  // 真人玩家看到自己的牌，并发送各自的座位索引
  room.players.forEach((p, idx) => {
    if (!p.ws || p.isAI) return;
    const myPlayers = publicPlayers.map((pp, i) => {
      if (i === idx) {
        return { ...pp, hand: p.hand || [], handRevealed: true };
      }
      return pp;
    });
    p.ws.send(JSON.stringify({
      type: 'state',
      yourIdx: idx,
      room: { code: room.code, state: room.state, roundNum: room.roundNum, totalRounds: room.totalRounds },
      players: myPlayers,
      community: room.community,
      pot: room.pot,
      currentBet: room.currentBet,
      smallBlind: room.smallBlind,
      bigBlind: room.bigBlind,
      dealerIdx: room.dealerIdx,
      curPlayerIdx: room.curPlayerIdx,
      phase: room.phase,
      phaseName: PHASES[room.phase] || ''
    }));
  });
}

function nextActiveFromIdx(room, idx) {
  const n = room.players.length;
  for (let i = 1; i <= n; i++) {
    const ni = (idx + i) % n;
    const p = room.players[ni];
    if (!p.folded && !p.allIn && p.chips > 0) return ni;
  }
  return idx;
}

function isBettingRoundOver(room) {
  const active = room.players.filter(p => !p.folded);
  const canAct = active.filter(p => !p.allIn && p.chips > 0);
  if (canAct.length === 0) return true;
  const maxBet = Math.max(...active.map(p => p.bet));
  const allActed = canAct.every(p => p.hasActed);
  const allMatched = canAct.every(p => p.bet === maxBet);
  return allActed && allMatched;
}

function executeAction(room, idx, type, amount) {
  const p = room.players[idx];
  const activePlayers = room.players.filter(pp => !pp.folded);
  const maxBet = Math.max(...activePlayers.map(pp => pp.bet));
  const toCall = maxBet - p.bet;

  if (type === 'fold') {
    p.folded = true; p.hasActed = true;
    broadcast(room, {type:'log', msg: p.name + ' 弃牌'});
  } else if (type === 'check') {
    p.hasActed = true;
    if (toCall === 0) broadcast(room, {type:'log', msg: p.name + ' 过牌'});
    else { p.folded = true; broadcast(room, {type:'log', msg: p.name + ' 弃牌'}); }
  } else if (type === 'call') {
    const pay = Math.min(toCall, p.chips);
    p.chips -= pay; p.bet += pay; p.totalBet += pay; room.pot += pay;
    p.hasActed = true;
    if (p.chips === 0) p.allIn = true;
    broadcast(room, {type:'log', msg: p.name + ' 跟注 ' + pay});
  } else if (type === 'raise') {
    const targetBet = Math.min(amount, p.bet + p.chips);
    const pay = targetBet - p.bet;
    p.chips -= pay; p.bet = targetBet; p.totalBet += pay; room.pot += pay;
    room.minRaise = targetBet - maxBet; room.currentBet = targetBet;
    p.hasActed = true;
    room.players.forEach((pp,i) => { if (i !== idx && !pp.folded && !pp.allIn) pp.hasActed = false; });
    if (p.chips === 0) p.allIn = true;
    broadcast(room, {type:'log', msg: p.name + ' 加注到 ' + targetBet});
  } else if (type === 'allin') {
    const pay = p.chips; p.chips = 0; p.bet += pay; p.totalBet += pay; room.pot += pay;
    p.allIn = true; p.hasActed = true;
    if (p.bet > maxBet) {
      room.minRaise = p.bet - maxBet; room.currentBet = p.bet;
      room.players.forEach((pp,i) => { if (i !== idx && !pp.folded && !pp.allIn) pp.hasActed = false; });
    }
    broadcast(room, {type:'log', msg: p.name + ' 全押 ' + pay});
  }

  proceedAction(room);
}

function advancePhase(room) {
  room.phase++;
  room.players.forEach(p => { p.bet = 0; p.hasActed = false; });
  room.currentBet = 0;
  room.minRaise = room.bigBlind;

  if (room.phase === 1) {
    room.deck.pop();
    room.community.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
    broadcast(room, {type:'log', msg: '翻牌'});
  } else if (room.phase === 2) {
    room.deck.pop(); room.community.push(room.deck.pop());
    broadcast(room, {type:'log', msg: '转牌'});
  } else if (room.phase === 3) {
    room.deck.pop(); room.community.push(room.deck.pop());
    broadcast(room, {type:'log', msg: '河牌'});
  } else if (room.phase >= 4) {
    showdown(room); return;
  }

  // 翻牌后从庄家左边开始
  room.curPlayerIdx = nextActiveFromIdx(room, room.dealerIdx);
  broadcastState(room);
  proceedAction(room);
}

function autoDealToShowdown(room) {
  const dealNext = () => {
    if (room.phase >= 3) {
      showdown(room);
      return;
    }
    room.phase++;
    if (room.phase === 1) {
      room.deck.pop();
      room.community.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
    } else { room.deck.pop(); room.community.push(room.deck.pop()); }
    broadcastState(room);
    setTimeout(dealNext, 800);
  };
  dealNext();
}

function showdown(room) {
  room.phase = 4;
  room.state = 'result';
  const contenders = room.players.filter(p => !p.folded);
  if (contenders.length === 0) {
    // 安全兜底：所有人都弃牌（不应该发生但防御一下）
    const alive = room.players.filter(p => p.chips > 0);
    if (alive.length > 0) awardPot(room, [alive[0]]);
    return;
  }
  if (contenders.length === 1) {
    awardPot(room, [contenders[0]]);
    return;
  }
  const results = contenders.map(p => ({
    player: p,
    hand: getBestHand([...p.hand, ...room.community])
  }));
  results.sort((a,b) => compareHands(b.hand, a.hand));
  const winners = [results[0]];
  for (let i = 1; i < results.length; i++) {
    if (compareHands(results[i].hand, results[0].hand) === 0) winners.push(results[i]);
    else break;
  }
  const winPlayers = winners.map(w => w.player);
  awardPot(room, winPlayers, results);
}

function awardPot(room, winners, results) {
  const activePlayers = room.players.filter(p => !p.folded || p.totalBet > 0);
  const sidePots = calculateSidePots(activePlayers);
  const winSet = new Set(winners);

  sidePots.forEach(pot => {
    const potWinners = pot.eligible.filter(p => winSet.has(p));
    if (potWinners.length === 0) {
      const stillIn = pot.eligible.filter(p => !p.folded);
      if (stillIn.length > 0) {
        const share = Math.floor(pot.amount / stillIn.length);
        stillIn.forEach(p => p.chips += share);
      }
    } else {
      const share = Math.floor(pot.amount / potWinners.length);
      potWinners.forEach(p => p.chips += share);
    }
  });

  const winNames = winners.map(w => w.name).join(', ');
  broadcast(room, {type:'log', msg: winNames + ' 获胜'});

  // 摊牌时给所有玩家发手牌信息
  if (results) {
    const revealData = results.map(r => ({
      name: r.player.name,
      hand: r.player.hand,
      handName: r.hand.name,
      isWinner: winners.includes(r.player)
    }));
    broadcast(room, {type:'reveal', data: revealData});
  }

  room.state = 'result';
  broadcastState(room);

  // 广播结果
  const resultData = {
    type: 'result',
    winners: winners.map(w => w.name),
    results: results ? results.map(r => ({
      name: r.player.name,
      avatar: r.player.avatar,
      handName: r.hand.name,
      hand: r.player.hand,
      isWinner: winners.includes(r.player),
      delta: r.player.chips - room.handStartChips[room.players.indexOf(r.player)]
    })) : room.players.map((p,i) => ({
      name: p.name, avatar: p.avatar,
      handName: winners.includes(p) ? '赢得底池' : '弃牌',
      hand: winners.includes(p) ? p.hand : [],
      isWinner: winners.includes(p),
      delta: p.chips - room.handStartChips[i]
    })),
    pot: room.pot,
    community: room.community
  };
  broadcast(room, resultData);
}

function startHand(room) {
  // 如果游戏已经结束，不再开始新局
  if (room.state === 'ended') return;
  room.roundNum++;
  if (room.roundNum > room.totalRounds) { endMatch(room); return; }
  // 检查是否有玩家破产（任何玩家筹码归零都结束）
  const alive = room.players.filter(p => p.chips > 0);
  if (alive.length < 2) { endMatch(room); return; }

  room.smallBlind = 10 + Math.floor((room.roundNum-1)/5)*5;
  room.bigBlind = room.smallBlind * 2;
  room.handStartChips = room.players.map(p => p.chips);
  room.players.forEach(p => { p.hand=[]; p.folded=false; p.allIn=false; p.bet=0; p.totalBet=0; p.hasActed=false; });
  room.players.forEach(p => { if (p.chips <= 0) p.folded = true; });

  room.deck = shuffle(createDeck());
  room.community = [];
  room.pot = 0;
  room.currentBet = 0;
  room.minRaise = room.bigBlind;
  room.phase = 0;
  room.state = 'dealing';

  // 庄家轮转
  do { room.dealerIdx = (room.dealerIdx + 1) % room.players.length; }
  while (room.players[room.dealerIdx].chips <= 0);

  // 盲注
  const sbIdx = nextActiveFromIdx(room, room.dealerIdx);
  const bbIdx = nextActiveFromIdx(room, sbIdx);
  const sbPay = Math.min(room.smallBlind, room.players[sbIdx].chips);
  room.players[sbIdx].chips -= sbPay; room.players[sbIdx].bet = sbPay; room.players[sbIdx].totalBet = sbPay;
  if (room.players[sbIdx].chips === 0) room.players[sbIdx].allIn = true;
  const bbPay = Math.min(room.bigBlind, room.players[bbIdx].chips);
  room.players[bbIdx].chips -= bbPay; room.players[bbIdx].bet = bbPay; room.players[bbIdx].totalBet = bbPay;
  if (room.players[bbIdx].chips === 0) room.players[bbIdx].allIn = true;
  room.pot = sbPay + bbPay;
  room.currentBet = room.bigBlind;

  // 发牌
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < room.players.length; j++) {
      const idx = (room.dealerIdx + 1 + j) % room.players.length;
      if (!room.players[idx].folded) room.players[idx].hand.push(room.deck.pop());
    }
  }

  room.curPlayerIdx = nextActiveFromIdx(room, bbIdx);
  room.state = 'betting';
  broadcast(room, {type:'log', msg: '=== 第' + room.roundNum + '局开始 ==='});
  broadcast(room, {type:'phase', phase: 0, phaseName: '翻牌前'});
  broadcastState(room);
  proceedAction(room);
}

function proceedAction(room) {
  if (room.timer) clearTimeout(room.timer);

  const active = room.players.filter(p => !p.folded);
  if (active.length === 1) {
    awardPot(room, [active[0]]);
    return;
  }
  const canAct = active.filter(p => !p.allIn && p.chips > 0);
  if (canAct.length === 0) { autoDealToShowdown(room); return; }
  if (isBettingRoundOver(room)) { advancePhase(room); return; }

  // 找到下一个需要行动的玩家（未弃牌、未全押、有筹码、未行动过）
  const n = room.players.length;
  let found = false;
  for (let i = 0; i < n; i++) {
    const idx = (room.curPlayerIdx + i) % n;
    const pp = room.players[idx];
    if (!pp.folded && !pp.allIn && pp.chips > 0 && !pp.hasActed) {
      room.curPlayerIdx = idx;
      found = true;
      break;
    }
  }
  // 安全兜底：所有能行动的玩家都行动过了，强制进入下一阶段
  if (!found) {
    advancePhase(room);
    return;
  }

  const p = room.players[room.curPlayerIdx];
  broadcastState(room);

  if (p.isAI) {
    room.timer = setTimeout(() => {
      const action = aiDecide(p, room);
      executeAction(room, room.curPlayerIdx, action.type, action.amount);
    }, 1500 + Math.random() * 2000);
  } else {
    // 等待真人玩家行动，设置30秒超时
    room.timer = setTimeout(() => {
      if (room.curPlayerIdx === room.players.indexOf(p)) {
        const maxBet = Math.max(...room.players.filter(pp => !pp.folded).map(pp => pp.bet));
        const toCall = maxBet - p.bet;
        if (toCall === 0) executeAction(room, room.players.indexOf(p), 'check');
        else executeAction(room, room.players.indexOf(p), 'fold');
      }
    }, 30000);
  }
}

function endMatch(room) {
  room.state = 'ended';
  const rank = [...room.players].sort((a,b) => b.chips - a.chips);
  broadcast(room, {
    type: 'endMatch',
    ranking: rank.map((p,i) => ({
      name: p.name, avatar: p.avatar, chips: p.chips, rank: i+1, isAI: p.isAI
    }))
  });
}

// ==================== HTTP + WebSocket 服务器（同端口） ====================
const httpServer = http.createServer((req, res) => {
  let filePath = req.url === '/' || req.url === '/texas-holdem-online.html' ? '/texas-holdem-online.html' : req.url;
  // 去掉query string
  filePath = filePath.split('?')[0];
  // 优先从server目录找，其次从上级目录找
  let fullPath = path.join(__dirname, filePath);
  if (!fs.existsSync(fullPath)) {
    fullPath = path.join(__dirname, '..', filePath);
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(fullPath);
    const types = { '.html':'text/html; charset=utf-8', '.js':'application/javascript', '.css':'text/css' };
    res.writeHead(200, {'Content-Type': types[ext] || 'application/octet-stream'});
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server: httpServer });

httpServer.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});

let playerIdCounter = 0;

wss.on('connection', (ws) => {
  let playerRoom = null;
  let playerIdx = -1;
  let myPlayerId = -1;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch(e) { return; }

    if (msg.type === 'createRoom') {
      const room = createRoom(msg.name, msg.totalRounds, msg.difficulty, msg.fillAI);
      myPlayerId = ++playerIdCounter;
      const player = {
        id: myPlayerId,
        name: msg.name,
        avatar: msg.avatar || '😀',
        chips: 1000,
        isAI: false,
        isHost: true,
        ws: ws,
        hand: [], folded: false, allIn: false, bet: 0, totalBet: 0, hasActed: false
      };
      room.players.push(player);
      playerRoom = room;
      playerIdx = 0;
      ws.send(JSON.stringify({type:'roomCreated', code: room.code, playerId: myPlayerId}));
      broadcastState(room);
    }

    else if (msg.type === 'joinRoom') {
      const room = rooms[msg.code];
      if (!room) { ws.send(JSON.stringify({type:'error', msg:'房间不存在'})); return; }
      if (room.state !== 'waiting') { ws.send(JSON.stringify({type:'error', msg:'游戏已开始，无法加入'})); return; }
      if (room.players.filter(p => !p.isAI).length >= 6) { ws.send(JSON.stringify({type:'error', msg:'房间已满'})); return; }

      myPlayerId = ++playerIdCounter;
      const player = {
        id: myPlayerId,
        name: msg.name,
        avatar: msg.avatar || '😀',
        chips: 1000,
        isAI: false,
        isHost: false,
        ws: ws,
        hand: [], folded: false, allIn: false, bet: 0, totalBet: 0, hasActed: false
      };
      room.players.push(player);
      playerRoom = room;
      playerIdx = room.players.length - 1;
      ws.send(JSON.stringify({type:'joined', code: room.code, playerId: myPlayerId}));
      broadcast(room, {type:'log', msg: msg.name + ' 加入了房间'});
      broadcastState(room);
    }

    else if (msg.type === 'reconnect') {
      // 断线重连：用playerId找回房间
      const pid = msg.playerId;
      const room = msg.roomCode ? rooms[msg.roomCode] : null;
      if (!room) { ws.send(JSON.stringify({type:'error', msg:'房间不存在'})); return; }
      const idx = room.players.findIndex(p => p.id === pid);
      if (idx < 0) { ws.send(JSON.stringify({type:'error', msg:'找不到玩家'})); return; }
      room.players[idx].ws = ws;
      room.players[idx].connected = true;
      playerRoom = room;
      playerIdx = idx;
      myPlayerId = pid;
      ws.send(JSON.stringify({type:'reconnected', code: room.code}));
      broadcastState(room);
    }

    else if (msg.type === 'getState') {
      if (playerRoom) broadcastState(playerRoom);
    }

    else if (msg.type === 'addAI') {
      if (!playerRoom || !playerRoom.players[playerIdx].isHost) return;
      if (playerRoom.state !== 'waiting') return;
      if (playerRoom.players.length >= 6) return;
      const aiIdx = playerRoom.aiCount;
      const aiPlayer = {
        id: ++playerIdCounter,
        name: AI_NAMES[aiIdx % AI_NAMES.length],
        avatar: AI_AVATARS[aiIdx % AI_AVATARS.length],
        chips: 1000,
        isAI: true,
        isHost: false,
        ws: null,
        hand: [], folded: false, allIn: false, bet: 0, totalBet: 0, hasActed: false,
        difficulty: playerRoom.difficulty,
        aggression: playerRoom.difficulty === 'hard' ? 0.8 : playerRoom.difficulty === 'normal' ? 0.55 : 0.35,
        bluffRate: playerRoom.difficulty === 'hard' ? 0.18 : playerRoom.difficulty === 'normal' ? 0.10 : 0.04
      };
      playerRoom.players.push(aiPlayer);
      playerRoom.aiCount++;
      broadcast(room = playerRoom, {type:'log', msg: aiPlayer.name + ' (AI) 加入了房间'});
      broadcastState(playerRoom);
    }

    else if (msg.type === 'removeAI') {
      if (!playerRoom || !playerRoom.players[playerIdx].isHost) return;
      if (playerRoom.state !== 'waiting') return;
      const aiIdx = playerRoom.players.findIndex(p => p.isAI);
      if (aiIdx >= 0) {
        const name = playerRoom.players[aiIdx].name;
        playerRoom.players.splice(aiIdx, 1);
        playerRoom.aiCount--;
        broadcast(playerRoom, {type:'log', msg: name + ' (AI) 离开了房间'});
        broadcastState(playerRoom);
      }
    }

    else if (msg.type === 'startGame') {
      if (!playerRoom || !playerRoom.players[playerIdx].isHost) return;
      if (playerRoom.players.length < 2) { ws.send(JSON.stringify({type:'error', msg:'至少需要2名玩家'})); return; }

      // 如果开启AI填充且人数不够，自动添加AI
      if (playerRoom.fillAI && playerRoom.players.length < 2) {
        while (playerRoom.players.length < 2) {
          const aiIdx = playerRoom.aiCount;
          playerRoom.players.push({
            id: ++playerIdCounter,
            name: AI_NAMES[aiIdx % AI_NAMES.length],
            avatar: AI_AVATARS[aiIdx % AI_AVATARS.length],
            chips: 1000, isAI: true, isHost: false, ws: null,
            hand: [], folded: false, allIn: false, bet: 0, totalBet: 0, hasActed: false,
            difficulty: playerRoom.difficulty,
            aggression: playerRoom.difficulty === 'hard' ? 0.8 : playerRoom.difficulty === 'normal' ? 0.55 : 0.35,
            bluffRate: playerRoom.difficulty === 'hard' ? 0.18 : playerRoom.difficulty === 'normal' ? 0.10 : 0.04
          });
          playerRoom.aiCount++;
        }
      }

      playerRoom.roundNum = 0;
      playerRoom.dealerIdx = -1;
      broadcast(playerRoom, {type:'gameStart'});
      startHand(playerRoom);
    }

    else if (msg.type === 'action') {
      if (!playerRoom) return;
      if (playerRoom.state !== 'betting') return;
      if (playerRoom.curPlayerIdx !== playerIdx) return;
      executeAction(playerRoom, playerIdx, msg.action, msg.amount);
    }

    else if (msg.type === 'nextHand') {
      if (!playerRoom) return;
      if (playerRoom.state === 'ended') return;
      // 所有玩家都可以点准备
      const p = playerRoom.players[playerIdx];
      if (p) {
        p.ready = true;
        // 通知所有人该玩家已准备
        broadcast(playerRoom, {type:'log', msg: p.name + ' 已准备'});
        // 检查所有人类玩家是否都已准备
        const humanPlayers = playerRoom.players.filter(pl => !pl.isAI);
        const allReady = humanPlayers.every(pl => pl.ready);
        if (allReady) {
          // 重置准备状态
          playerRoom.players.forEach(pl => pl.ready = false);
          // 先通知所有客户端清除结算弹窗
          broadcast(playerRoom, {type:'clearResult'});
          playerRoom.state = 'dealing';
          startHand(playerRoom);
        } else {
          // 广播当前准备状态
          broadcast(playerRoom, {type:'readyState', ready: humanPlayers.map(pl => ({name: pl.name, ready: pl.ready}))});
        }
      }
    }

    else if (msg.type === 'leaveRoom') {
      if (playerRoom) {
        broadcast(playerRoom, {type:'log', msg: playerRoom.players[playerIdx].name + ' 离开了房间'});
        playerRoom.players[playerIdx].ws = null;
        playerRoom.players[playerIdx].connected = false;
        // 如果游戏进行中，标记弃牌
        if (playerRoom.state === 'betting' || playerRoom.state === 'dealing') {
          playerRoom.players[playerIdx].folded = true;
        }
        broadcastState(playerRoom);
      }
    }
  });

  ws.on('close', () => {
    if (playerRoom && playerIdx >= 0) {
      const p = playerRoom.players[playerIdx];
      if (p) {
        p.ws = null;
        p.connected = false;
        broadcast(playerRoom, {type:'log', msg: p.name + ' 断线了'});
        if (playerRoom.state === 'betting' || playerRoom.state === 'dealing') {
          p.folded = true;
          if (playerRoom.curPlayerIdx === playerIdx) {
            playerRoom.curPlayerIdx = nextActiveFromIdx(playerRoom, playerIdx);
            setTimeout(() => proceedAction(playerRoom), 300);
          }
        }
        broadcastState(playerRoom);
      }
    }
  });
});
