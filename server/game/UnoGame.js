// server/game/UnoGame.js

class UnoGame {
  constructor(roomId, players) {
    this.roomId = roomId;
    this.players = Array.isArray(players) ? [...players] : [];
    this.deck = this.createAndShuffleDeck();
    this.playerHands = {};
    
    // Inicjalizacja rąk graczy
    for (const playerAddress of this.players) {
      this.playerHands[playerAddress] = [];
      for (let i = 0; i < 7; i++) {
        const card = this.drawFromDeck();
        if (card) {
          this.playerHands[playerAddress].push(card);
        }
      }
    }
    
    this.currentCard = this.drawFromDeck();
    this.currentPlayerIndex = 0;
    this.direction = 1; // 1 dla zgodnie z ruchem wskazówek zegara, -1 przeciwnie
    this.winner = null;
    this.isActive = true;
    this.turnStartTime = new Date().toISOString();
    this.lastAction = {
      action: "start",
      player: this.players[0],
      timestamp: new Date().toISOString()
    };
  }

  createAndShuffleDeck() {
    const colors = ['red', 'blue', 'green', 'yellow'];
    const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Skip', 'Reverse', 'Draw2'];
    
    let deck = [];

    // Dodaj karty kolorowe
    for (const color of colors) {
      for (const value of values) {
        deck.push({ color, value });
        
        // Dodaj drugą kartę każdego typu (z wyjątkiem 0)
        if (value !== '0') {
          deck.push({ color, value });
        }
      }
    }

    // Dodaj karty specjalne
    for (let i = 0; i < 4; i++) {
      deck.push({ color: 'black', value: 'Wild' });
      deck.push({ color: 'black', value: 'Wild4' });
    }

    // Tasowanie talii
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    return deck;
  }

  drawFromDeck() {
    if (this.deck.length === 0) {
      return null; // Brak kart w talii
    }
    return this.deck.pop();
  }

  getPlayerHand(playerAddress) {
    return this.playerHands[playerAddress] || [];
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

  playCard(playerAddress, cardIndex, chosenColor = null) {
    // Sprawdź, czy gra jest aktywna
    if (!this.isActive || this.winner) {
      throw new Error("Gra została zakończona");
    }
    
    // Sprawdź, czy gracz jest w grze
    const playerIndex = this.players.indexOf(playerAddress);
    if (playerIndex === -1) {
      throw new Error("Nie jesteś uczestnikiem tej gry");
    }
    
    // Sprawdź, czy to kolej gracza
    if (playerIndex !== this.currentPlayerIndex) {
      throw new Error("Nie jest twoja kolej");
    }
    
    // Pobierz rękę gracza
    const playerHand = this.playerHands[playerAddress];
    if (!playerHand || cardIndex < 0 || cardIndex >= playerHand.length) {
      throw new Error("Nieprawidłowy indeks karty");
    }
    
    // Pobierz kartę
    const card = playerHand[cardIndex];
    
    // Sprawdź, czy ruch jest dozwolony
    if (!this.isValidMove(card, this.currentCard)) {
      throw new Error("Nieprawidłowy ruch");
    }
    
    // Usuń kartę z ręki gracza
    const playedCard = playerHand.splice(cardIndex, 1)[0];
    
    // Jeśli to karta Wild, ustaw wybrany kolor
    if (playedCard.color === 'black') {
      if (!chosenColor || !['red', 'blue', 'green', 'yellow'].includes(chosenColor)) {
        throw new Error("Musisz wybrać prawidłowy kolor dla karty Wild");
      }
      
      this.currentCard = { ...playedCard, color: chosenColor };
    } else {
      this.currentCard = playedCard;
    }
    
    // Aktualizuj czas rozpoczęcia tury i ostatnią akcję
    this.turnStartTime = new Date().toISOString();
    this.lastAction = {
      action: "play",
      player: playerAddress,
      card: playedCard,
      timestamp: new Date().toISOString()
    };
    
    // Sprawdź, czy gracz wygrał
    if (playerHand.length === 0) {
      this.winner = playerAddress;
      this.isActive = false;
      this.lastAction.result = "win";
      
      return { winner: playerAddress };
    }
    
    // Obsłuż efekty specjalnych kart
    this.handleSpecialCardEffects(playedCard);
    
    return { success: true };
  }

  handleSpecialCardEffects(card) {
    // Znajdź indeks aktualnego gracza (dla pewności)
    const currentPlayerIndex = this.currentPlayerIndex;
    
    switch (card.value) {
      case 'Skip':
        // Pomiń następnego gracza
        this.currentPlayerIndex = this.getNextPlayerIndex();
        break;
      case 'Reverse':
        // Zmień kierunek gry
        this.direction *= -1;
        
        // Dla 2 graczy, działa jak Skip
        if (this.players.length === 2) {
          break;
        }
        break;
      case 'Draw2':
        // Następny gracz dobiera 2 karty
        const nextPlayerDraw2Index = this.getNextPlayerIndex();
        const nextPlayerDraw2 = this.players[nextPlayerDraw2Index];
        const nextPlayerDraw2Hand = this.playerHands[nextPlayerDraw2];
        
        // Dobierz 2 karty
        for (let i = 0; i < 2; i++) {
          const card = this.drawFromDeck();
          if (card) {
            nextPlayerDraw2Hand.push(card);
          }
        }
        
        // Pomiń następnego gracza
        this.currentPlayerIndex = this.getNextPlayerIndex(nextPlayerDraw2Index);
        return;
      case 'Wild4':
        // Następny gracz dobiera 4 karty
        const nextPlayerWild4Index = this.getNextPlayerIndex();
        const nextPlayerWild4 = this.players[nextPlayerWild4Index];
        const nextPlayerWild4Hand = this.playerHands[nextPlayerWild4];
        
        // Dobierz 4 karty
        for (let i = 0; i < 4; i++) {
          const card = this.drawFromDeck();
          if (card) {
            nextPlayerWild4Hand.push(card);
          }
        }
        
        // Pomiń następnego gracza
        this.currentPlayerIndex = this.getNextPlayerIndex(nextPlayerWild4Index);
        return;
    }
    
    // Dla innych kart, przejdź do następnego gracza
    this.currentPlayerIndex = this.getNextPlayerIndex();
  }

  getNextPlayerIndex(fromIndex = this.currentPlayerIndex) {
    return (fromIndex + this.direction + this.players.length) % this.players.length;
  }

  drawCard(playerAddress) {
    // Sprawdź, czy gra jest aktywna
    if (!this.isActive || this.winner) {
      throw new Error("Gra została zakończona");
    }
    
    // Sprawdź, czy gracz jest w grze
    const playerIndex = this.players.indexOf(playerAddress);
    if (playerIndex === -1) {
      throw new Error("Nie jesteś uczestnikiem tej gry");
    }
    
    // Sprawdź, czy to kolej gracza
    if (playerIndex !== this.currentPlayerIndex) {
      throw new Error("Nie jest twoja kolej");
    }
    
    // Sprawdź, czy w talii są jeszcze karty
    if (this.deck.length === 0) {
      throw new Error("Brak kart w talii");
    }
    
    // Pobierz kartę z talii
    const drawnCard = this.drawFromDeck();
    
    // Dodaj kartę do ręki gracza
    const playerHand = this.playerHands[playerAddress];
    playerHand.push(drawnCard);
    
    // Aktualizuj czas rozpoczęcia tury i ostatnią akcję
    this.turnStartTime = new Date().toISOString();
    this.lastAction = {
      action: "draw",
      player: playerAddress,
      timestamp: new Date().toISOString()
    };
    
    // Przejdź do następnego gracza
    this.currentPlayerIndex = this.getNextPlayerIndex();
    
    return drawnCard;
  }

  // Pobieranie stanu gry z perspektywy konkretnego gracza
  getGameStateForPlayer(playerAddress) {
    // Sprawdź, czy gracz jest w grze
    const playerIndex = this.players.indexOf(playerAddress);
    
    const baseState = this.getGameState();
    
    // Dodaj specyficzne informacje dla gracza
    return {
      ...baseState,
      playerHand: this.playerHands[playerAddress] || [],
      playerIndex,
      otherPlayersCardCount: this.players.reduce((acc, player) => {
        if (player !== playerAddress) {
          acc[player] = (this.playerHands[player] || []).length;
        }
        return acc;
      }, {})
    };
  }

  // Pobieranie podstawowego stanu gry
  getGameState() {
    return {
      roomId: this.roomId,
      currentCard: this.currentCard,
      currentPlayerIndex: this.currentPlayerIndex,
      direction: this.direction,
      deckSize: this.deck.length,
      turnStartTime: this.turnStartTime,
      lastAction: this.lastAction,
      winner: this.winner,
      isActive: this.isActive,
      players: this.players
    };
  }
}

module.exports = UnoGame;