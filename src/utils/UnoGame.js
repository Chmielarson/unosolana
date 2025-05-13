// src/utils/UnoGame.js

class UnoGame {
  constructor(numberOfPlayers) {
    this.deck = this.createDeck();
    this.shuffleDeck();
    this.players = Array(numberOfPlayers)
      .fill()
      .map(() => []);
    this.dealCards();
    this.currentCard = this.drawFromDeck();
    this.currentPlayer = 0;
    this.direction = 1; // 1 dla zgodnie z ruchem wskazówek zegara, -1 przeciwnie
  }

  createDeck() {
    const colors = ['red', 'blue', 'green', 'yellow'];
    const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Skip', 'Reverse', 'Draw2'];
    const specialCards = [
      { color: 'black', value: 'Wild' },
      { color: 'black', value: 'Wild4' }
    ];

    let deck = [];

    // Dodajemy karty kolorowe
    for (const color of colors) {
      for (const value of values) {
        deck.push({ color, value });
        
        // Dodajemy drugą kartę każdego typu, z wyjątkiem 0
        if (value !== '0') {
          deck.push({ color, value });
        }
      }
    }

    // Dodajemy karty specjalne
    for (let i = 0; i < 4; i++) { // 4 karty Wild i 4 karty Wild4
      deck.push({ ...specialCards[0] });
      deck.push({ ...specialCards[1] });
    }

    return deck;
  }

  shuffleDeck() {
    for (let i = this.deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
    }
  }

  drawFromDeck() {
    if (this.deck.length === 0) {
      return null; // Brak kart w talii
    }
    return this.deck.pop();
  }

  dealCards() {
    // Każdy gracz otrzymuje 7 kart
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j < this.players.length; j++) {
        const card = this.drawFromDeck();
        if (card) {
          this.players[j].push(card);
        }
      }
    }
  }

  getPlayerHand(playerIndex) {
    if (playerIndex < 0 || playerIndex >= this.players.length) {
      return [];
    }
    return [...this.players[playerIndex]];
  }

  getCurrentCard() {
    return this.currentCard;
  }

  getCurrentPlayerIndex() {
    return this.currentPlayer;
  }

  isValidMove(card, currentCard) {
    // Karta Wild lub Wild4 zawsze może być zagrana
    if (card.color === 'black') {
      return true;
    }

    // Zgodność koloru lub wartości
    return (
      card.color === currentCard.color || 
      card.value === currentCard.value
    );
  }

  playCard(playerIndex, cardIndex, chosenColor = null) {
    if (playerIndex !== this.currentPlayer) {
      return false; // Nie jest kolej tego gracza
    }

    const hand = this.players[playerIndex];
    if (cardIndex < 0 || cardIndex >= hand.length) {
      return false; // Nieprawidłowy indeks karty
    }

    const card = hand[cardIndex];
    if (!this.isValidMove(card, this.currentCard)) {
      return false; // Nieprawidłowy ruch
    }

    // Usuń kartę z ręki gracza
    const playedCard = hand.splice(cardIndex, 1)[0];
    
    // Aktualizuj aktualną kartę
    this.currentCard = playedCard;
    
    // Jeśli karta jest Wildcard, ustaw wybrany kolor
    if (playedCard.color === 'black' && chosenColor) {
      this.currentCard.color = chosenColor;
    }
    
    // Obsługa efektów specjalnych kart
    this.handleSpecialCardEffects(playedCard);
    
    // Sprawdź, czy gracz wygrał
    if (hand.length === 0) {
      return { winner: playerIndex };
    }
    
    return true;
  }

  handleSpecialCardEffects(card) {
    switch (card.value) {
      case 'Skip':
        // Pomiń następnego gracza
        this.currentPlayer = (this.currentPlayer + this.direction + this.players.length) % this.players.length;
        break;
      case 'Reverse':
        // Zmień kierunek gry
        this.direction *= -1;
        
        // Jeśli jest tylko 2 graczy, działa jak Skip
        if (this.players.length === 2) {
          this.currentPlayer = (this.currentPlayer + this.direction + this.players.length) % this.players.length;
        }
        break;
      case 'Draw2':
        // Następny gracz dobiera 2 karty
        const nextPlayer = (this.currentPlayer + this.direction + this.players.length) % this.players.length;
        for (let i = 0; i < 2; i++) {
          const card = this.drawFromDeck();
          if (card) {
            this.players[nextPlayer].push(card);
          }
        }
        break;
      case 'Wild4':
        // Następny gracz dobiera 4 karty
        const nextPlayerForWild4 = (this.currentPlayer + this.direction + this.players.length) % this.players.length;
        for (let i = 0; i < 4; i++) {
          const card = this.drawFromDeck();
          if (card) {
            this.players[nextPlayerForWild4].push(card);
          }
        }
        break;
    }
    
    // Przejdź do następnego gracza (jeśli nie była to karta Skip lub Reverse)
    if (card.value !== 'Skip' && card.value !== 'Reverse') {
      this.currentPlayer = (this.currentPlayer + this.direction + this.players.length) % this.players.length;
    }
  }

  // Dodatkowa funkcja do dobierania karty przez gracza
  drawCard(playerIndex) {
    if (playerIndex !== this.currentPlayer) {
      return false; // Nie jest kolej tego gracza
    }
    
    const card = this.drawFromDeck();
    if (!card) {
      return false; // Brak kart w talii
    }
    
    this.players[playerIndex].push(card);
    
    // Przejdź do następnego gracza
    this.currentPlayer = (this.currentPlayer + this.direction + this.players.length) % this.players.length;
    
    return card;
  }

  // Funkcja do uzyskania informacji o stanie gry
  getGameState() {
    return {
      currentCard: this.currentCard,
      currentPlayer: this.currentPlayer,
      direction: this.direction,
      deckSize: this.deck.length,
      playersCardsCount: this.players.map(hand => hand.length)
    };
  }

  // Funkcja do sprawdzania, czy gracz może wykonać ruch
  canPlayerMove(playerIndex) {
    if (playerIndex !== this.currentPlayer) {
      return false;
    }
    
    const hand = this.players[playerIndex];
    
    // Sprawdź, czy gracz ma kartę, którą może zagrać
    return hand.some(card => this.isValidMove(card, this.currentCard));
  }
}

export default UnoGame;