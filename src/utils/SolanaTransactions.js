// src/utils/SolanaTransactions.js (część 1)
import { 
  Connection, 
  SystemProgram, 
  Transaction, 
  PublicKey, 
  LAMPORTS_PER_SOL,
  clusterApiUrl
} from '@solana/web3.js';
import { db } from '../firebase';
import { 
  collection, addDoc, getDocs, getDoc, doc, 
  updateDoc, setDoc, query, where, arrayUnion 
} from 'firebase/firestore';

// Połączenie z siecią Solana
const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');

// Utworzenie Public Key dla programu (smart contract)
// W rzeczywistej implementacji, zastąp ten adres rzeczywistym adresem programu
const PROGRAM_ID = new PublicKey('3PtVXcKqQTQpUyCn5RCsrKL9nnHsAD6Kinf81LeBr1Vs');

// Zamień TYLKO funkcję simulateTransaction w pliku src/utils/SolanaTransactions.js:

async function simulateTransaction(amount, wallet) {
  console.log("Simulating transaction for amount:", amount, "SOL");
  
  if (typeof amount !== 'number' || isNaN(amount) || amount <= 0) {
    throw new Error(`Nieprawidłowa kwota: ${amount} SOL`);
  }
  
  if (!wallet || !wallet.publicKey || !wallet.signTransaction) {
    throw new Error('Nieprawidłowy portfel');
  }
  
  const { publicKey, signTransaction } = wallet;
  
  // Konwersja SOL na lamports (1 SOL = 1,000,000,000 lamports)
  const lamports = Math.round(amount * LAMPORTS_PER_SOL);

  try {
    // Tworzenie transakcji
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: publicKey,
        toPubkey: PROGRAM_ID,
        lamports: lamports
      })
    );

    // Pobierz ostatni blok
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = publicKey;

    // Podpisz transakcję
    let signedTransaction;
    try {
      signedTransaction = await signTransaction(transaction);
    } catch (signError) {
      throw new Error(`Błąd podpisu: ${signError.message}`);
    }

    // Wyślij transakcję
    const signature = await connection.sendRawTransaction(
      signedTransaction.serialize()
    );

    // Poczekaj na potwierdzenie z timeoutem
    const confirmationPromise = connection.confirmTransaction({
      blockhash,
      lastValidBlockHeight,
      signature
    }, 'confirmed');
    
    // Dodaj timeout 15 sekund
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Timeout potwierdzenia transakcji')), 15000)
    );
    
    // Wyścig między potwierdzeniem a timeoutem
    const confirmation = await Promise.race([confirmationPromise, timeoutPromise]);
    
    if (confirmation.value && confirmation.value.err) {
      throw new Error(`Transakcja odrzucona: ${JSON.stringify(confirmation.value.err)}`);
    }

    console.log("Transaction confirmed:", signature);
    return signature;
  } catch (error) {
    console.error('Transaction error:', error);
    throw new Error(`Błąd transakcji: ${error.message}`);
  }
}

// Funkcja do pobrania listy pokojów
export async function getRooms() {
  console.log("Getting rooms list");
  try {
    const roomsCollection = collection(db, 'rooms');
    const roomsSnapshot = await getDocs(roomsCollection);
    
    console.log("Rooms found:", roomsSnapshot.docs.length);
    
    return roomsSnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        creatorAddress: data.creatorAddress,
        maxPlayers: data.maxPlayers,
        currentPlayers: data.players.length,
        entryFee: data.entryFee,
        pool: data.entryFee * data.players.length,
        gameStarted: data.gameStarted
      };
    });
  } catch (error) {
    console.error('Error getting rooms:', error);
    return [];
  }
}

// Funkcja do tworzenia nowego pokoju
export async function createRoom(maxPlayers, entryFee, wallet) {
  console.log("Creating room with:", { maxPlayers, entryFee });
  console.log("Wallet:", wallet);
  
  const { publicKey } = wallet;
  
  if (!publicKey) {
    throw new Error('Portfel nie jest połączony');
  }

  const roomData = {
    creatorAddress: publicKey.toString(),
    maxPlayers,
    entryFee,
    players: [publicKey.toString()],
    gameStarted: false,
    winner: null,
    createdAt: new Date().toISOString()
  };

  try {
    // Symulacja transakcji wpisowego od twórcy pokoju
    console.log("Simulating transaction for room creation");
    await simulateTransaction(entryFee, wallet);
    
    // Dodanie pokoju do Firestore
    console.log("Adding room to Firestore");
    const docRef = await addDoc(collection(db, 'rooms'), roomData);
    console.log("Room created with ID:", docRef.id);
    
    // Inicjalizacja stanu gry
    console.log("Initializing game state");
    await setDoc(doc(db, 'gameStates', docRef.id), {
      deck: createAndShuffleDeck(),
      playerHands: {
        [publicKey.toString()]: []
      },
      currentCard: null,
      currentPlayerIndex: 0,
      direction: 1,
      lastAction: null,
      gameStarted: false
    });
    
    console.log("Room creation completed");
    return docRef.id;
  } catch (error) {
    console.error('Error creating room:', error);
    throw error;
  }
}

// Zamień TYLKO funkcję joinRoom w pliku src/utils/SolanaTransactions.js:

export async function joinRoom(roomId, entryFee, wallet) {
  console.log("Join room function called:", { roomId, entryFee });
  
  // Zabezpieczenie przed nieprawidłowymi danymi wejściowymi
  if (!roomId) {
    throw new Error('Brak identyfikatora pokoju');
  }
  
  if (typeof entryFee !== 'number' || isNaN(entryFee) || entryFee <= 0) {
    throw new Error('Nieprawidłowa kwota wpisowego');
  }
  
  if (!wallet || !wallet.publicKey) {
    throw new Error('Portfel nie jest połączony');
  }
  
  const { publicKey, signTransaction } = wallet;
  
  if (!signTransaction) {
    throw new Error('Portfel nie ma funkcji podpisywania transakcji');
  }

  try {
    // 1. Pobierz dane pokoju
    const roomRef = doc(db, 'rooms', roomId);
    const roomSnap = await getDoc(roomRef);
    
    if (!roomSnap.exists()) {
      throw new Error('Pokój nie istnieje');
    }
    
    const roomData = roomSnap.data();
    
    // 2. Sprawdź, czy gracz już jest w pokoju
    if (roomData.players.includes(publicKey.toString())) {
      console.log("Player already in room");
      return true; // Już jesteś w tym pokoju
    }
    
    // 3. Walidacja
    if (roomData.players.length >= roomData.maxPlayers) {
      throw new Error('Pokój jest pełny');
    }
    
    if (roomData.gameStarted) {
      throw new Error('Gra już się rozpoczęła');
    }

    // 4. Najpierw zapisz gracza do pokoju (ważne, żeby zrobić to przed transakcją)
    console.log("Adding player to room:", publicKey.toString());
    await updateDoc(roomRef, {
      players: arrayUnion(publicKey.toString())
    });
    
    // 5. Transakcja wpisowego
    console.log("Simulating transaction for entry fee:", entryFee);
    try {
      await simulateTransaction(entryFee, wallet);
    } catch (txError) {
      // W przypadku błędu transakcji, usuń gracza z pokoju
      try {
        const updatedRoomData = { 
          players: roomData.players.filter(p => p !== publicKey.toString()) 
        };
        await updateDoc(roomRef, updatedRoomData);
      } catch (cleanupError) {
        console.error("Error cleaning up after failed transaction:", cleanupError);
      }
      throw txError;
    }
    
    // 6. Dodaj gracza do stanu gry
    console.log("Adding player to game state");
    try {
      const gameStateRef = doc(db, 'gameStates', roomId);
      const gameStateSnap = await getDoc(gameStateRef);
      
      if (gameStateSnap.exists()) {
        const gameState = gameStateSnap.data();
        
        // Przygotuj aktualizację ręki gracza
        const updatedPlayerHands = { ...gameState.playerHands };
        updatedPlayerHands[publicKey.toString()] = [];
        
        await updateDoc(gameStateRef, {
          playerHands: updatedPlayerHands
        });
      }
    } catch (gameStateError) {
      console.error("Error updating game state:", gameStateError);
      // Kontynuujemy mimo błędu, bo gracz i tak jest już w pokoju
    }
    
    // 7. Sprawdź, czy pokój jest pełny - rozpocznij grę, jeśli tak
    try {
      const updatedRoomSnap = await getDoc(roomRef);
      const updatedRoomData = updatedRoomSnap.data();
      
      if (updatedRoomData.players.length >= updatedRoomData.maxPlayers) {
        console.log("Room is full, starting game");
        await updateDoc(roomRef, {
          gameStarted: true
        });
        
        // Inicjalizacja gry
        await initializeGameState(roomId);
      }
    } catch (startGameError) {
      console.error("Error starting game:", startGameError);
      // Nie przerywa, dołączanie i tak już zakończone
    }
    
    console.log("Join room completed successfully");
    return true;
  } catch (error) {
    console.error('Error joining room:', error);
    throw error;
  }
}

// Funkcja initializeGameState w SolanaTransactions.js

async function initializeGameState(roomId) {
  console.log("Initializing game state for room:", roomId);
  try {
    const roomRef = doc(db, 'rooms', roomId);
    const roomSnap = await getDoc(roomRef);
    
    if (!roomSnap.exists()) {
      console.error("Room not found for game initialization");
      return;
    }
    
    const roomData = roomSnap.data();
    const gameStateRef = doc(db, 'gameStates', roomId);
    const gameStateSnap = await getDoc(gameStateRef);
    
    if (!gameStateSnap.exists()) {
      console.error("Game state not found for initialization");
      return;
    }
    
    // Utwórz nową talię kart
    const deck = createAndShuffleDeck();
    console.log("Deck created with", deck.length, "cards");
    
    // Rozdaj karty graczom - WAŻNE: upewnij się, że każdy gracz otrzymuje karty
    const playerHands = {};
    
    for (const playerAddress of roomData.players) {
      playerHands[playerAddress] = [];
      for (let i = 0; i < 7; i++) {
        if (deck.length > 0) {
          playerHands[playerAddress].push(deck.pop());
        }
      }
      console.log("Dealt", playerHands[playerAddress].length, "cards to player", playerAddress);
    }
    
    // Wyłóż pierwszą kartę na stół
    let currentCard = null;
    if (deck.length > 0) {
      currentCard = deck.pop();
      
      // Jeśli pierwsza karta to Wild lub Wild4, wybierz losowo kolor
      if (currentCard.color === 'black') {
        const colors = ['red', 'blue', 'green', 'yellow'];
        const randomColor = colors[Math.floor(Math.random() * colors.length)];
        currentCard = { ...currentCard, color: randomColor };
        console.log("First card was Wild, changed color to:", randomColor);
      }
    }
    
    console.log("First card on table:", currentCard);
    
    // Aktualizacja stanu gry
    await updateDoc(gameStateRef, {
      deck,
      playerHands,
      currentCard,
      currentPlayerIndex: 0,
      direction: 1,
      gameStarted: true,
      lastAction: {
        action: 'start',
        player: roomData.players[0],
        timestamp: new Date().toISOString()
      }
    });
    
    console.log("Game state initialized successfully");
  } catch (error) {
    console.error("Error initializing game state:", error);
  }
}
// Funkcja do utworzenia i potasowania talii kart UNO
function createAndShuffleDeck() {
  const colors = ['red', 'blue', 'green', 'yellow'];
  const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Skip', 'Reverse', 'Draw2'];
  
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

  // Dodajemy karty specjalne Wild i Wild Draw 4
  for (let i = 0; i < 4; i++) {
    deck.push({ color: 'black', value: 'Wild' });
    deck.push({ color: 'black', value: 'Wild4' });
  }

  // Tasujemy talię
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

// Funkcja do pobrania informacji o pokoju
export async function getRoomInfo(roomId) {
  console.log("Getting room info for room:", roomId);
  
  try {
    const roomRef = doc(db, 'rooms', roomId);
    console.log("Room reference:", roomRef);
    
    const roomSnap = await getDoc(roomRef);
    console.log("Room snapshot exists:", roomSnap.exists());
    
    if (!roomSnap.exists()) {
      throw new Error('Pokój nie istnieje');
    }
    
    const roomData = roomSnap.data();
    console.log("Room data:", roomData);
    
    return {
      id: roomId,
      creatorAddress: roomData.creatorAddress,
      maxPlayers: roomData.maxPlayers,
      currentPlayers: roomData.players.length,
      players: roomData.players,
      entryFee: roomData.entryFee,
      pool: roomData.entryFee * roomData.players.length,
      gameStarted: roomData.gameStarted,
      winner: roomData.winner,
      createdAt: roomData.createdAt
    };
  } catch (error) {
    console.error('Error getting room info:', error);
    throw error;
  }
}

// Funkcja do pobrania stanu gry dla gracza
export async function getGameState(roomId, wallet) {
  console.log("Getting game state for room:", roomId);
  try {
    const { publicKey } = wallet;
    
    if (!publicKey) {
      throw new Error('Portfel nie jest połączony');
    }
    
    const roomRef = doc(db, 'rooms', roomId);
    const roomSnap = await getDoc(roomRef);
    
    if (!roomSnap.exists()) {
      throw new Error('Pokój nie istnieje');
    }
    
    const roomData = roomSnap.data();
    const playerAddress = publicKey.toString();
    
    if (!roomData.players.includes(playerAddress)) {
      throw new Error('Nie jesteś uczestnikiem tej gry');
    }
    
    const gameStateRef = doc(db, 'gameStates', roomId);
    const gameStateSnap = await getDoc(gameStateRef);
    
    if (!gameStateSnap.exists()) {
      throw new Error('Stan gry nie istnieje');
    }
    
    const gameState = gameStateSnap.data();
    
    // Zwróć stan gry z perspektywy danego gracza
    const playerState = {
      currentCard: gameState.currentCard,
      playerHand: gameState.playerHands[playerAddress] || [],
      currentPlayerIndex: Number(gameState.currentPlayerIndex),
      playerIndex: Number(roomData.players.indexOf(playerAddress)),
      playersCount: roomData.players.length,
      direction: gameState.direction,
      deckSize: gameState.deck.length,
      otherPlayersCardCount: roomData.players.reduce((acc, addr) => {
        if (addr !== playerAddress) {
          acc[addr] = (gameState.playerHands[addr] || []).length;
        }
        return acc;
      }, {}),
      lastAction: gameState.lastAction,
      winner: roomData.winner
    };
    
    console.log("Player state:", playerState);
    return playerState;
  } catch (error) {
    console.error('Error getting game state:', error);
    throw error;
  }
}

// Funkcja do zagrania karty
export async function playCard(roomId, cardIndex, chosenColor = null, wallet) {
  console.log("Playing card:", { roomId, cardIndex, chosenColor });
  try {
    const { publicKey } = wallet;
    
    if (!publicKey) {
      throw new Error('Portfel nie jest połączony');
    }
    
    const playerAddress = publicKey.toString();
    
    // Pobierz dane pokoju
    const roomRef = doc(db, 'rooms', roomId);
    const roomSnap = await getDoc(roomRef);
    
    if (!roomSnap.exists()) {
      throw new Error('Pokój nie istnieje');
    }
    
    const roomData = roomSnap.data();
    const playerIndex = roomData.players.indexOf(playerAddress);
    
    if (playerIndex === -1) {
      throw new Error('Nie jesteś uczestnikiem tej gry');
    }
    
    // Pobierz stan gry
    const gameStateRef = doc(db, 'gameStates', roomId);
    const gameStateSnap = await getDoc(gameStateRef);
    
    if (!gameStateSnap.exists()) {
      throw new Error('Stan gry nie istnieje');
    }
    
    const gameState = gameStateSnap.data();
    
    if (gameState.currentPlayerIndex !== playerIndex) {
      throw new Error('Nie jest twoja kolej');
    }
    
    const playerHand = gameState.playerHands[playerAddress];
    
    if (!playerHand || cardIndex < 0 || cardIndex >= playerHand.length) {
      throw new Error('Nieprawidłowy indeks karty');
    }
    
    const card = playerHand[cardIndex];
    
    // Sprawdź, czy karta może być zagrana
    if (!isValidMove(card, gameState.currentCard)) {
      throw new Error('Nieprawidłowy ruch');
    }
    
    // Usuń kartę z ręki gracza
    const playedCard = playerHand.splice(cardIndex, 1)[0];
    
    // Aktualizuj bieżącą kartę
    let updatedCard = { ...playedCard };
    
    // Jeśli karta to Wild lub Wild4, ustaw wybrany kolor
    if (playedCard.color === 'black' && chosenColor) {
      if (['red', 'blue', 'green', 'yellow'].includes(chosenColor)) {
        updatedCard = { ...playedCard, color: chosenColor };
      }
    }
    
    // Przygotuj aktualizację stanu gry
    const gameStateUpdate = {
      playerHands: { ...gameState.playerHands },
      currentCard: updatedCard,
      lastAction: {
        player: playerAddress,
        action: 'play',
        card: playedCard,
        timestamp: new Date().toISOString()
      }
    };
    
    // Zaktualizuj rękę gracza
    gameStateUpdate.playerHands[playerAddress] = playerHand;
    
    // Obsłuż efekty specjalnych kart
    const specialCardEffects = handleSpecialCardEffects(
      roomData.players,
      gameState,
      playedCard,
      playerIndex
    );
    
    // Połącz aktualizacje
    Object.assign(gameStateUpdate, specialCardEffects);
    
    // Sprawdź, czy gracz wygrał
    if (playerHand.length === 0) {
      // Aktualizuj pokój - ustaw zwycięzcę
      await updateDoc(roomRef, {
        winner: playerAddress
      });
      
      gameStateUpdate.lastAction.result = 'win';
      
      // Aktualizuj stan gry
      await updateDoc(gameStateRef, gameStateUpdate);
      
      return { winner: playerAddress };
    }
    
    // Aktualizuj stan gry
    await updateDoc(gameStateRef, gameStateUpdate);
    
    return true;
  } catch (error) {
    console.error('Error playing card:', error);
    throw error;
  }
}

// Funkcja do dobierania karty
export async function drawCard(roomId, wallet) {
  console.log("Drawing card from room:", roomId);
  try {
    const { publicKey } = wallet;
    
    if (!publicKey) {
      throw new Error('Portfel nie jest połączony');
    }
    
    const playerAddress = publicKey.toString();
    
    // Pobierz dane pokoju
    const roomRef = doc(db, 'rooms', roomId);
    const roomSnap = await getDoc(roomRef);
    
    if (!roomSnap.exists()) {
      throw new Error('Pokój nie istnieje');
    }
    
    const roomData = roomSnap.data();
    const playerIndex = roomData.players.indexOf(playerAddress);
    
    if (playerIndex === -1) {
      throw new Error('Nie jesteś uczestnikiem tej gry');
    }
    
    // Pobierz stan gry
    const gameStateRef = doc(db, 'gameStates', roomId);
    const gameStateSnap = await getDoc(gameStateRef);
    
    if (!gameStateSnap.exists()) {
      throw new Error('Stan gry nie istnieje');
    }
    
    const gameState = gameStateSnap.data();
    
    if (gameState.currentPlayerIndex !== playerIndex) {
      throw new Error('Nie jest twoja kolej');
    }
    
    // Sprawdź, czy w talii są jeszcze karty
    if (gameState.deck.length === 0) {
      throw new Error('Brak kart w talii');
    }
    
    // Pobierz kartę z talii
    const drawnCard = gameState.deck.pop();
    
    // Dodaj kartę do ręki gracza
    const playerHand = gameState.playerHands[playerAddress] || [];
    playerHand.push(drawnCard);
    
    // Przygotuj aktualizację stanu gry
    const updatedPlayerHands = { ...gameState.playerHands };
    updatedPlayerHands[playerAddress] = playerHand;
    
    // Oblicz następnego gracza
    const nextPlayerIndex = getNextPlayerIndex(
      roomData.players.length,
      gameState.currentPlayerIndex,
      gameState.direction
    );
    
    // Aktualizuj stan gry
    await updateDoc(gameStateRef, {
      deck: gameState.deck,
      playerHands: updatedPlayerHands,
      currentPlayerIndex: nextPlayerIndex,
      lastAction: {
        player: playerAddress,
        action: 'draw',
        timestamp: new Date().toISOString()
      }
    });
    
    console.log("Card drawn successfully");
    return drawnCard;
  } catch (error) {
    console.error('Error drawing card:', error);
    throw error;
  }
}

// Funkcja do sprawdzania, czy ruch jest prawidłowy
function isValidMove(card, currentCard) {
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

// Funkcja do obsługi efektów kart specjalnych
function handleSpecialCardEffects(players, gameState, card, playerIndex) {
  const updates = {};
  let nextPlayerIndex = getNextPlayerIndex(
    players.length,
    playerIndex,
    gameState.direction
  );
  
  switch (card.value) {
    case 'Skip':
      // Pomiń następnego gracza
      nextPlayerIndex = getNextPlayerIndex(
        players.length,
        nextPlayerIndex,
        gameState.direction
      );
      updates.currentPlayerIndex = nextPlayerIndex;
      break;
      
    case 'Reverse':
      // Zmień kierunek gry
      updates.direction = gameState.direction * -1;
      
      // Jeśli jest tylko 2 graczy, działa jak Skip
      if (players.length === 2) {
        // Nie zmieniaj bieżącego gracza
        updates.currentPlayerIndex = playerIndex;
      } else {
        // Zmień gracza zgodnie z nowym kierunkiem
        nextPlayerIndex = getNextPlayerIndex(
          players.length,
          playerIndex,
          updates.direction
        );
        updates.currentPlayerIndex = nextPlayerIndex;
      }
      break;
      
    case 'Draw2':
      // Następny gracz dobiera 2 karty
      const nextPlayerDraw2Address = players[nextPlayerIndex];
      const nextPlayerDraw2Hand = gameState.playerHands[nextPlayerDraw2Address] || [];
      
      for (let i = 0; i < 2; i++) {
        if (gameState.deck.length > 0) {
          nextPlayerDraw2Hand.push(gameState.deck.pop());
        }
      }
      
      const updatedHandsDraw2 = { ...gameState.playerHands };
      updatedHandsDraw2[nextPlayerDraw2Address] = nextPlayerDraw2Hand;
      
      updates.playerHands = updatedHandsDraw2;
      updates.deck = gameState.deck;
      
      // Przejdź o 2 graczy dalej (pomijając gracza, który dobiera karty)
      nextPlayerIndex = getNextPlayerIndex(
        players.length,
        nextPlayerIndex,
        gameState.direction
      );
      updates.currentPlayerIndex = nextPlayerIndex;
      break;
      
    case 'Wild4':
      // Następny gracz dobiera 4 karty
      const nextPlayerWild4Address = players[nextPlayerIndex];
      const nextPlayerWild4Hand = gameState.playerHands[nextPlayerWild4Address] || [];
      
      for (let i = 0; i < 4; i++) {
        if (gameState.deck.length > 0) {
          nextPlayerWild4Hand.push(gameState.deck.pop());
        }
      }
      
      const updatedHandsWild4 = { ...gameState.playerHands };
      updatedHandsWild4[nextPlayerWild4Address] = nextPlayerWild4Hand;
      
      updates.playerHands = updatedHandsWild4;
      updates.deck = gameState.deck;
      
      // Przejdź o 2 graczy dalej (pomijając gracza, który dobiera karty)
      nextPlayerIndex = getNextPlayerIndex(
        players.length,
        nextPlayerIndex,
        gameState.direction
      );
      updates.currentPlayerIndex = nextPlayerIndex;
      break;
      
    default:
      // Dla zwykłych kart, przejdź do następnego gracza
      updates.currentPlayerIndex = nextPlayerIndex;
  }
  
  return updates;
}

// Funkcja do obliczenia indeksu następnego gracza
function getNextPlayerIndex(playersCount, currentIndex, direction) {
  return (currentIndex + direction + playersCount) % playersCount;
}

// Funkcja do odebrania nagrody przez zwycięzcę
export async function claimPrize(roomId, wallet) {
  console.log("Claiming prize for room:", roomId);
  try {
    const { publicKey } = wallet;
    
    if (!publicKey) {
      throw new Error('Portfel nie jest połączony');
    }
    
    const playerAddress = publicKey.toString();
    
    // Pobierz dane pokoju
    const roomRef = doc(db, 'rooms', roomId);
    const roomSnap = await getDoc(roomRef);
    
    if (!roomSnap.exists()) {
      throw new Error('Pokój nie istnieje');
    }
    
    const roomData = roomSnap.data();
    
    if (roomData.winner !== playerAddress) {
      throw new Error('Tylko zwycięzca może odebrać nagrodę');
    }
    
    if (roomData.prizeClaimedBy) {
      throw new Error('Nagroda została już odebrana');
    }
    
    // Oblicz nagrodę
    const prize = roomData.entryFee * roomData.players.length;
    
    // W rzeczywistej implementacji, przesłalibyśmy SOL do zwycięzcy
    // Symulujemy to tylko
    
    // Oznacz nagrodę jako odebraną
    await updateDoc(roomRef, {
      prizeClaimedBy: playerAddress,
      prizeClaimedAt: new Date().toISOString()
    });
    
    console.log("Prize claimed successfully:", prize, "SOL");
    return {
      winner: playerAddress,
      prize,
      claimedAt: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error claiming prize:', error);
    throw error;
  }
}