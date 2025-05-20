// server/index.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Connection, PublicKey } = require('@solana/web3.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Połączenie z Solana
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

// Przechowywanie stanów gier w pamięci (lub bazie danych)
const gameStates = new Map();

// Logika gry UNO
class UnoGameState {
  constructor(roomId, players) {
    this.roomId = roomId;
    this.players = players;
    this.deck = this.createAndShuffleDeck();
    this.playerHands = {};
    players.forEach(player => {
      this.playerHands[player] = [];
      for (let i = 0; i < 7; i++) {
        this.playerHands[player].push(this.deck.pop());
      }
    });
    this.currentCard = this.deck.pop();
    this.currentPlayerIndex = 0;
    this.direction = 1;
    this.turnStartTime = new Date().toISOString();
    this.lastAction = null;
  }
  
  // Zaimplementuj tutaj pozostałe metody z UnoGame.js
  createAndShuffleDeck() { /* ... */ }
  playCard(player, cardIndex, chosenColor) { /* ... */ }
  drawCard(player) { /* ... */ }
  getGameState(forPlayer) { /* ... */ }
}

// Socket.IO eventy
io.on('connection', (socket) => {
  socket.on('join_game', ({ roomId, playerAddress }) => {
    // Sprawdź, czy gra istnieje
    let game = gameStates.get(roomId);
    
    if (!game) {
      // Sprawdź on-chain, czy taki pokój istnieje i jest aktywny
      // Jeśli tak, zainicjuj nową grę
    }
    
    // Dołącz gracza do pokoju
    socket.join(roomId);
    
    // Wyślij aktualny stan gry
    socket.emit('game_state_update', game.getGameState(playerAddress));
  });
  
  socket.on('play_card', async ({ roomId, playerAddress, cardIndex, chosenColor }) => {
    let game = gameStates.get(roomId);
    if (!game) return;
    
    const result = game.playCard(playerAddress, cardIndex, chosenColor);
    
    // Jeśli gra się zakończyła, zainicjuj zakończenie na łańcuchu
    if (result.winner) {
      // Wywołaj endGame na blockchainie
      
      // Powiadom wszystkich graczy
      io.to(roomId).emit('game_ended', { winner: result.winner });
    } else {
      // Wyślij aktualizację stanu gry
      io.to(roomId).emit('game_state_update', game.getGameState());
    }
  });
  
  socket.on('draw_card', ({ roomId, playerAddress }) => {
    // Implementacja podobna do play_card
  });
});

server.listen(3001, () => {
  console.log('Serwer działa na porcie 3001');
});