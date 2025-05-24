#!/bin/bash
# Skrypt do testowania i wdrażania programu Solana UNO - wersja hybrydowa

# Kolory dla lepszej czytelności
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}======================================================${NC}"
echo -e "${BLUE}      UNO na Solanie - Skrypt wdrożeniowy     ${NC}"
echo -e "${BLUE}======================================================${NC}"

# Sprawdź, czy Solana CLI jest zainstalowane
if ! command -v solana &> /dev/null; then
    echo -e "${RED}Błąd: Solana CLI nie jest zainstalowane.${NC}"
    echo -e "${YELLOW}Zainstaluj Solana CLI następującym poleceniem:${NC}"
    echo -e "sh -c \"$(curl -sSfL https://release.solana.com/v1.14.6/install)\""
    exit 1
fi

# Sprawdź, czy Rust i Cargo są zainstalowane
if ! command -v cargo &> /dev/null; then
    echo -e "${RED}Błąd: Rust i Cargo nie są zainstalowane.${NC}"
    echo -e "${YELLOW}Zainstaluj Rust i Cargo następującym poleceniem:${NC}"
    echo -e "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
fi

# Sprawdź, czy Node.js i npm są zainstalowane
if ! command -v node &> /dev/null || ! command -v npm &> /dev/null; then
    echo -e "${RED}Błąd: Node.js i npm są wymagane do uruchomienia serwera gry.${NC}"
    echo -e "${YELLOW}Zainstaluj Node.js i npm ze strony:${NC}"
    echo -e "https://nodejs.org/en/download/"
    exit 1
fi

# Sprawdź, czy użytkownik jest zalogowany do Solana
SOLANA_PUBKEY=$(solana address 2>/dev/null)
if [ $? -ne 0 ]; then
    echo -e "${YELLOW}Nie znaleziono lokalnego portfela Solana. Czy chcesz utworzyć nowy? (t/n)${NC}"
    read -r response
    if [[ "$response" =~ ^([tT][aA][kK]|[tT])$ ]]; then
        solana-keygen new --no-passphrase
        echo -e "${GREEN}Utworzono nowy portfel Solana.${NC}"
    else
        echo -e "${RED}Wyjście: Potrzebny jest portfel Solana do wdrożenia programu.${NC}"
        exit 1
    fi
fi

# Wybór sieci
echo -e "${YELLOW}Wybierz sieć Solana do wdrożenia:${NC}"
echo "1. Lokalny klaster (localhost)"
echo "2. Devnet (testowa sieć)"
echo "3. Mainnet (produkcyjna sieć)"
read -r network_choice

case $network_choice in
    1)
        NETWORK="localhost"
        SERVER_URL="http://localhost:3001"
        echo -e "${YELLOW}Sprawdzanie czy lokalny klaster jest uruchomiony...${NC}"
        if ! solana cluster-version --url localhost &> /dev/null; then
            echo -e "${RED}Lokalny klaster nie jest uruchomiony.${NC}"
            echo -e "${YELLOW}Czy chcesz uruchomić lokalny klaster Solana? (t/n)${NC}"
            read -r start_cluster
            if [[ "$start_cluster" =~ ^([tT][aA][kK]|[tT])$ ]]; then
                echo -e "${GREEN}Uruchamianie lokalnego klastra Solana...${NC}"
                solana-test-validator &
                sleep 5
            else
                echo -e "${RED}Wyjście: Lokalny klaster jest wymagany.${NC}"
                exit 1
            fi
        fi
        ;;
    2)
        NETWORK="devnet"
        SERVER_URL="https://uno-server.example.com" # Zastąp rzeczywistym adresem serwera
        ;;
    3)
        NETWORK="mainnet-beta"
        SERVER_URL="https://uno-server-prod.example.com" # Zastąp rzeczywistym adresem produkcyjnego serwera
        echo -e "${RED}UWAGA: Wdrażasz na produkcyjną sieć Mainnet!${NC}"
        echo -e "${RED}Czy jesteś pewien, że chcesz kontynuować? (tak/NIE)${NC}"
        read -r mainnet_confirm
        if [[ "$mainnet_confirm" != "tak" ]]; then
            echo -e "${YELLOW}Anulowano wdrażanie na Mainnet.${NC}"
            exit 0
        fi
        ;;
    *)
        echo -e "${RED}Nieprawidłowy wybór. Wyjście.${NC}"
        exit 1
        ;;
esac

# Ustaw wybraną sieć
echo -e "${GREEN}Ustawianie sieci na: ${NETWORK}${NC}"
solana config set --url $NETWORK

# Sprawdź saldo portfela
BALANCE=$(solana balance)
echo -e "${BLUE}Bieżące saldo portfela: ${BALANCE}${NC}"

# Dla testowych sieci, oferuj airdrop
if [[ "$NETWORK" == "devnet" || "$NETWORK" == "localhost" ]]; then
    echo -e "${YELLOW}Czy chcesz otrzymać SOL z airdropu? (t/n)${NC}"
    read -r airdrop
    if [[ "$airdrop" =~ ^([tT][aA][kK]|[tT])$ ]]; then
        echo -e "${GREEN}Wysyłanie żądania airdrop...${NC}"
        solana airdrop 2
        echo -e "${GREEN}Nowe saldo: $(solana balance)${NC}"
    fi
fi

# Sprawdź, czy katalog serwera istnieje
if [ ! -d "server" ]; then
    echo -e "${YELLOW}Tworzenie katalogu serwera...${NC}"
    mkdir -p server
    mkdir -p server/game
    mkdir -p server/solana
    mkdir -p server/routes
    
    # Utwórz podstawowe pliki serwera
    echo '{
  "name": "uno-solana-server",
  "version": "1.0.0",
  "description": "Backend server for UNO Solana game",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "dev": "nodemon index.js"
  },
  "dependencies": {
    "@solana/web3.js": "^1.87.3",
    "express": "^4.18.2", 
    "socket.io": "^4.7.2",
    "cors": "^2.8.5",
    "dotenv": "^10.0.0"
  },
  "devDependencies": {
    "nodemon": "^3.0.1"
  }
}' > server/package.json
    
    echo 'PORT=3001
SOLANA_PROGRAM_ID=
SOLANA_NETWORK=devnet
SOLANA_RPC_URL=https://api.devnet.solana.com' > server/.env
fi

# Przejdź do katalogu programu Solana
cd program || { echo -e "${RED}Nie można przejść do katalogu programu.${NC}"; exit 1; }

# Kompiluj program
echo -e "${BLUE}Kompilowanie programu Solana...${NC}"
cargo build-bpf || { echo -e "${RED}Kompilacja nie powiodła się.${NC}"; exit 1; }

# Wdróż program
echo -e "${BLUE}Wdrażanie programu na sieć: ${NETWORK}${NC}"
PROGRAM_OUTPUT=$(solana program deploy target/deploy/uno_solana.so 2>&1)
PROGRAM_ID=$(echo "$PROGRAM_OUTPUT" | grep "Program Id:" | cut -d' ' -f3)

if [ -z "$PROGRAM_ID" ]; then
    echo -e "${RED}Wdrażanie nie powiodło się. Sprawdź błędy powyżej.${NC}"
    exit 1
else
    echo -e "${GREEN}Program pomyślnie wdrożony!${NC}"
    echo -e "${GREEN}Program ID: ${PROGRAM_ID}${NC}"
    
    # Zapisz Program ID do pliku konfiguracyjnego
    cd ..
    echo "REACT_APP_PROGRAM_ID=${PROGRAM_ID}" > .env.local
    echo "REACT_APP_GAME_SERVER_URL=${SERVER_URL}" >> .env.local
    echo -e "${GREEN}ID programu zapisane w pliku .env.local${NC}"
    
    # Aktualizacja pliku środowiskowego serwera
    echo "PORT=3001
SOLANA_PROGRAM_ID=${PROGRAM_ID}
SOLANA_NETWORK=${NETWORK}
SOLANA_RPC_URL=$(solana config get json_rpc_url | cut -d ' ' -f 2)" > server/.env
    
    echo -e "${GREEN}Zaktualizowano konfigurację serwera w pliku server/.env${NC}"
    
    # Instrukcje aktualizacji frontendu
    echo -e "${YELLOW}Pamiętaj, aby zaktualizować PROGRAM_ID w pliku src/utils/SolanaTransactions.js:${NC}"
    echo -e "const PROGRAM_ID = new PublicKey('${PROGRAM_ID}');"
fi

# Instalacja zależności serwera
echo -e "${BLUE}Instalowanie zależności serwera...${NC}"
cd server || { echo -e "${RED}Nie można przejść do katalogu serwera.${NC}"; exit 1; }
npm install

# Utwórz główny plik serwera, jeśli nie istnieje
if [ ! -f "index.js" ]; then
    echo -e "${YELLOW}Tworzenie plików serwera...${NC}"
    echo 'const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const dotenv = require("dotenv");
const { Connection, PublicKey } = require("@solana/web3.js");

// Import tras
const roomsRoutes = require("./routes/rooms");
const gameRoutes = require("./routes/game");

// Import konfiguracji Solana
const { setupSolanaConnection } = require("./solana/connection");

// Ładowanie zmiennych środowiskowych
dotenv.config();

// Inicjalizacja Express
const app = express();
app.use(cors());
app.use(express.json());

// Ustawienie połączenia z Solana
const connection = setupSolanaConnection();

// Tworzenie serwera HTTP
const server = http.createServer(app);

// Inicjalizacja Socket.IO
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Udostępnianie połączenia Solana i io dla pozostałych modułów
app.set("solanaConnection", connection);
app.set("socketIo", io);

// Ustawienie tras
app.use("/api/rooms", roomsRoutes);
app.use("/api/game", gameRoutes);

// Obsługa Socket.IO
require("./game/socketHandler")(io, connection);

// Trasa główna
app.get("/", (req, res) => {
  res.send("UNO Solana Server Running");
});

// Nasłuchiwanie na porcie
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server działa na porcie ${PORT}`);
  console.log(`Połączono z siecią Solana: ${process.env.SOLANA_NETWORK}`);
  console.log(`Program ID: ${process.env.SOLANA_PROGRAM_ID}`);
});' > index.js

    # Utwórz katalogi, jeśli nie istnieją
    mkdir -p game
    mkdir -p solana
    mkdir -p routes

    # Utwórz plik połączenia z Solana
    echo 'const { Connection, clusterApiUrl } = require("@solana/web3.js");
const dotenv = require("dotenv");

dotenv.config();

const setupSolanaConnection = () => {
  // Używa RPC URL z pliku .env lub standardowego adresu dla sieci
  const rpcUrl = process.env.SOLANA_RPC_URL || clusterApiUrl(process.env.SOLANA_NETWORK || "devnet");
  
  return new Connection(rpcUrl, "confirmed");
};

module.exports = {
  setupSolanaConnection
};' > solana/connection.js

    # Utwórz plik obsługi Socket.IO
    echo 'const { PublicKey } = require("@solana/web3.js");
const { UnoGame } = require("./UnoGame");

// Przechowuj aktywne gry
const activeGames = new Map();

module.exports = (io, solanaConnection) => {
  io.on("connection", (socket) => {
    console.log(`New client connected: ${socket.id}`);

    // Obsługa dołączania do gry
    socket.on("join_game", ({ roomId, gameId, playerAddress }) => {
      console.log(`Player ${playerAddress} joining game ${roomId} with ID ${gameId}`);
      
      // Dołącz do pokoju Socket.IO
      socket.join(roomId);
      
      // Sprawdź, czy gra już istnieje
      let game = activeGames.get(roomId);
      
      if (!game) {
        // Utwórz nową grę, jeśli nie istnieje
        game = new UnoGame(roomId, gameId);
        activeGames.set(roomId, game);
      }
      
      // Dodaj gracza do gry
      game.addPlayer(playerAddress);
      
      // Wyślij aktualny stan gry
      const gameState = game.getGameStateForPlayer(playerAddress);
      socket.emit("game_state", gameState);
    });
    
    // Obsługa pobierania stanu gry
    socket.on("get_game_state", ({ roomId, playerAddress }) => {
      const game = activeGames.get(roomId);
      
      if (game) {
        const gameState = game.getGameStateForPlayer(playerAddress);
        socket.emit("game_state", gameState);
      } else {
        socket.emit("error", { message: "Game not found" });
      }
    });
    
    // Obsługa zagrania karty
    socket.on("play_card", ({ roomId, playerAddress, cardIndex, chosenColor }) => {
      const game = activeGames.get(roomId);
      
      if (game) {
        try {
          const result = game.playCard(playerAddress, cardIndex, chosenColor);
          socket.emit("play_card_result", result);
          
          // Wyślij aktualizację stanu gry do wszystkich graczy
          io.to(roomId).emit("game_state_update", game.getGameState());
        } catch (error) {
          socket.emit("play_card_result", { error: error.message });
        }
      } else {
        socket.emit("play_card_result", { error: "Game not found" });
      }
    });
    
    // Obsługa dobierania karty
    socket.on("draw_card", ({ roomId, playerAddress }) => {
      const game = activeGames.get(roomId);
      
      if (game) {
        try {
          const card = game.drawCard(playerAddress);
          socket.emit("draw_card_result", { card });
          
          // Wyślij aktualizację stanu gry do wszystkich graczy
          io.to(roomId).emit("game_state_update", game.getGameState());
        } catch (error) {
          socket.emit("draw_card_result", { error: error.message });
        }
      } else {
        socket.emit("draw_card_result", { error: "Game not found" });
      }
    });
    
    // Obsługa rozłączenia
    socket.on("disconnect", () => {
      console.log(`Client disconnected: ${socket.id}`);
    });
  });
};' > game/socketHandler.js

    # Utwórz plik klasy UnoGame
    echo 'class UnoGame {
  constructor(roomId, gameId) {
    this.roomId = roomId;
    this.gameId = gameId;
    this.players = [];
    this.deck = this.createAndShuffleDeck();
    this.playerHands = {};
    this.currentCard = null;
    this.currentPlayerIndex = 0;
    this.direction = 1; // 1 zgodnie z ruchem wskazówek zegara, -1 przeciwnie
    this.turnStartTime = new Date().toISOString();
    this.lastAction = null;
    this.winner = null;
    this.isActive = true;
  }
  
  // Dodawanie gracza do gry
  addPlayer(playerAddress) {
    if (!this.players.includes(playerAddress)) {
      this.players.push(playerAddress);
      this.playerHands[playerAddress] = [];
      
      // Rozdaj karty, jeśli gra została już zainicjalizowana
      if (this.currentCard) {
        this.dealCards(playerAddress);
      }
    }
  }
  
  // Inicjalizacja gry
  startGame() {
    // Sprawdź, czy gra już została rozpoczęta
    if (this.currentCard) return;
    
    // Rozdaj karty wszystkim graczom
    for (const player of this.players) {
      this.dealCards(player);
    }
    
    // Wyłóż pierwszą kartę
    this.currentCard = this.deck.pop();
    
    // Jeśli pierwsza karta to Wild, wybierz losowy kolor
    if (this.currentCard.color === "black") {
      const colors = ["red", "blue", "green", "yellow"];
      this.currentCard.color = colors[Math.floor(Math.random() * colors.length)];
    }
    
    // Ustaw pierwszy ruch
    this.currentPlayerIndex = 0;
    this.turnStartTime = new Date().toISOString();
    this.lastAction = {
      action: "start",
      player: this.players[0],
      timestamp: new Date().toISOString()
    };
  }
  
  // Rozdanie kart graczowi
  dealCards(playerAddress) {
    const hand = this.playerHands[playerAddress] || [];
    
    // Rozdaj do 7 kart
    while (hand.length < 7 && this.deck.length > 0) {
      hand.push(this.deck.pop());
    }
    
    this.playerHands[playerAddress] = hand;
  }
  
  // Tworzenie i tasowanie talii
  createAndShuffleDeck() {
    const colors = ["red", "blue", "green", "yellow"];
    const values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "Skip", "Reverse", "Draw2"];
    
    let deck = [];
    
    // Dodaj karty kolorowe
    for (const color of colors) {
      for (const value of values) {
        deck.push({ color, value });
        
        // Dodaj drugą kartę każdego typu (z wyjątkiem 0)
        if (value !== "0") {
          deck.push({ color, value });
        }
      }
    }
    
    // Dodaj karty specjalne
    for (let i = 0; i < 4; i++) {
      deck.push({ color: "black", value: "Wild" });
      deck.push({ color: "black", value: "Wild4" });
    }
    
    // Tasuj talię
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    
    return deck;
  }
  
  // Sprawdzenie, czy ruch jest dozwolony
  isValidMove(card, currentCard) {
    // Karta Wild zawsze może być zagrana
    if (card.color === "black") {
      return true;
    }
    
    // Zgodność koloru lub wartości
    return card.color === currentCard.color || card.value === currentCard.value;
  }
  
  // Zagranie karty
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
    if (playedCard.color === "black") {
      if (!chosenColor || !["red", "blue", "green", "yellow"].includes(chosenColor)) {
        throw new Error("Musisz wybrać prawidłowy kolor dla karty Wild");
      }
      
      this.currentCard = { ...playedCard, color: chosenColor };
    } else {
      this.currentCard = playedCard;
    }
    
    // Aktualizuj ostatnią akcję
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
    this.handleSpecialCardEffects(playedCard, playerIndex);
    
    // Aktualizuj czas rozpoczęcia tury
    this.turnStartTime = new Date().toISOString();
    
    return { success: true };
  }
  
  // Obsługa efektów kart specjalnych
  handleSpecialCardEffects(card, playerIndex) {
    switch (card.value) {
      case "Skip":
        // Pomiń następnego gracza
        this.currentPlayerIndex = this.getNextPlayerIndex(this.currentPlayerIndex);
        break;
      case "Reverse":
        // Zmień kierunek gry
        this.direction *= -1;
        
        // Dla 2 graczy, działa jak Skip
        if (this.players.length === 2) {
          break;
        }
        break;
      case "Draw2":
        // Następny gracz dobiera 2 karty
        const nextPlayerDraw2Index = this.getNextPlayerIndex(playerIndex);
        const nextPlayerDraw2 = this.players[nextPlayerDraw2Index];
        const nextPlayerDraw2Hand = this.playerHands[nextPlayerDraw2];
        
        // Dobierz 2 karty
        for (let i = 0; i < 2; i++) {
          if (this.deck.length > 0) {
            nextPlayerDraw2Hand.push(this.deck.pop());
          }
        }
        
        // Pomiń następnego gracza
        this.currentPlayerIndex = this.getNextPlayerIndex(nextPlayerDraw2Index);
        return;
      case "Wild4":
        // Następny gracz dobiera 4 karty
        const nextPlayerWild4Index = this.getNextPlayerIndex(playerIndex);
        const nextPlayerWild4 = this.players[nextPlayerWild4Index];
        const nextPlayerWild4Hand = this.playerHands[nextPlayerWild4];
        
        // Dobierz 4 karty
        for (let i = 0; i < 4; i++) {
          if (this.deck.length > 0) {
            nextPlayerWild4Hand.push(this.deck.pop());
          }
        }
        
        // Pomiń następnego gracza
        this.currentPlayerIndex = this.getNextPlayerIndex(nextPlayerWild4Index);
        return;
    }
    
    // Przejdź do następnego gracza
    this.currentPlayerIndex = this.getNextPlayerIndex(playerIndex);
  }
  
  // Funkcja do obliczenia indeksu następnego gracza
  getNextPlayerIndex(currentIndex) {
    return (currentIndex + this.direction + this.players.length) % this.players.length;
  }
  
  // Dobieranie karty
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
    const drawnCard = this.deck.pop();
    
    // Dodaj kartę do ręki gracza
    const playerHand = this.playerHands[playerAddress];
    playerHand.push(drawnCard);
    
    // Aktualizuj ostatnią akcję
    this.lastAction = {
      action: "draw",
      player: playerAddress,
      timestamp: new Date().toISOString()
    };
    
    // Przejdź do następnego gracza
    this.currentPlayerIndex = this.getNextPlayerIndex(playerIndex);
    
    // Aktualizuj czas rozpoczęcia tury
    this.turnStartTime = new Date().toISOString();
    
    return drawnCard;
  }
  
  // Pobieranie stanu gry dla wszystkich graczy
  getGameState() {
    return {
      roomId: this.roomId,
      gameId: this.gameId,
      players: this.players,
      currentCard: this.currentCard,
      currentPlayerIndex: this.currentPlayerIndex,
      direction: this.direction,
      deckSize: this.deck.length,
      turnStartTime: this.turnStartTime,
      lastAction: this.lastAction,
      winner: this.winner,
      isActive: this.isActive
    };
  }
  
  // Pobieranie stanu gry dla konkretnego gracza
  getGameStateForPlayer(playerAddress) {
    // Jeśli gra nie została zainicjalizowana, zrób to teraz
    if (!this.currentCard && this.players.length >= 2) {
      this.startGame();
    }
    
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
}

module.exports = { UnoGame };' > game/UnoGame.js

    # Utwórz pliki tras
    echo 'const express = require("express");
const router = express.Router();
const { PublicKey } = require("@solana/web3.js");

// Przechowujemy pokoje w pamięci (w prawdziwym rozwiązaniu użylibyśmy bazy danych)
const rooms = new Map();

// Pobierz wszystkie aktywne pokoje
router.get("/", (req, res) => {
  try {
    const activeRooms = Array.from(rooms.values())
      .filter(room => room.isActive && !room.winner)
      .map(room => ({
        id: room.id,
        creatorAddress: room.creatorAddress,
        maxPlayers: room.maxPlayers,
        entryFee: room.entryFee,
        currentPlayers: room.players.length,
        gameStarted: room.gameStarted,
        roomAddress: room.roomAddress,
        players: room.players,
        lastActivity: room.lastActivity
      }));
    
    res.status(200).json(activeRooms);
  } catch (error) {
    console.error("Error getting rooms:", error);
    res.status(500).json({ error: "Failed to get rooms" });
  }
});

// Pobierz informacje o pokoju
router.get("/:id", (req, res) => {
  try {
    const roomId = req.params.id;
    const room = rooms.get(roomId);
    
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }
    
    res.status(200).json(room);
  } catch (error) {
    console.error("Error getting room:", error);
    res.status(500).json({ error: "Failed to get room" });
  }
});

// Utwórz nowy pokój
router.post("/", (req, res) => {
  try {
    const { creatorAddress, maxPlayers, entryFee, roomAddress } = req.body;
    
    if (!creatorAddress || !maxPlayers || !entryFee || !roomAddress) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    // Generuj unikalny identyfikator
    const roomId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    
    // Utwórz pokój
    const room = {
      id: roomId,
      creatorAddress,
      roomAddress,
      maxPlayers,
      entryFee,
      players: [creatorAddress],
      gameStarted: false,
      winner: null,
      createdAt: new Date().toISOString(),
      isActive: true,
      gameId: null,
      lastActivity: new Date().toISOString()
    };
    
    // Zapisz pokój
    rooms.set(roomId, room);
    
    res.status(201).json({ roomId });
  } catch (error) {
    console.error("Error creating room:", error);
    res.status(500).json({ error: "Failed to create room" });
  }
});

// Dołącz do pokoju
router.post("/:id/join", (req, res) => {
  try {
    const roomId = req.params.id;
    const { playerAddress } = req.body;
    
    if (!playerAddress) {
      return res.status(400).json({ error: "Missing player address" });
    }
    
    const room = rooms.get(roomId);
    
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }
    
    if (room.gameStarted) {
      return res.status(400).json({ error: "Game already started" });
    }
    
    if (room.players.length >= room.maxPlayers) {
      return res.status(400).json({ error: "Room is full" });
    }
    
    // Sprawdź, czy gracz już jest w pokoju
    if (!room.players.includes(playerAddress)) {
      room.players.push(playerAddress);
    }
    
    // Aktualizuj czas ostatniej aktywności
    room.lastActivity = new Date().toISOString();
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error joining room:", error);
    res.status(500).json({ error: "Failed to join room" });
  }
});

// Rozpocznij grę
router.post("/:id/start", (req, res) => {
  try {
    const roomId = req.params.id;
    const { gameId, initiatorAddress } = req.body;
    
    if (!gameId || !initiatorAddress) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    const room = rooms.get(roomId);
    
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }
    
    if (room.gameStarted) {
      return res.status(400).json({ error: "Game already started" });
    }
    
    // Sprawdź, czy inicjator jest w pokoju
    if (!room.players.includes(initiatorAddress)) {
      return res.status(403).json({ error: "Not authorized to start the game" });
    }
    
    // Rozpocznij grę
    room.gameStarted = true;
    room.gameId = gameId;
    room.lastActivity = new Date().toISOString();
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error starting game:", error);
    res.status(500).json({ error: "Failed to start game" });
  }
});

// Zakończ grę
router.post("/:id/end", (req, res) => {
  try {
    const roomId = req.params.id;
    const { winnerAddress } = req.body;
    
    if (!winnerAddress) {
      return res.status(400).json({ error: "Missing winner address" });
    }
    
    const room = rooms.get(roomId);
    
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }
    
    // Sprawdź, czy zwycięzca jest w pokoju
    if (!room.players.includes(winnerAddress)) {
      return res.status(400).json({ error: "Winner is not a player in this room" });
    }
    
    // Zakończ grę
    room.winner = winnerAddress;
    room.isActive = false;
    room.endedAt = new Date().toISOString();
    room.lastActivity = new Date().toISOString();
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error ending game:", error);
    res.status(500).json({ error: "Failed to end game" });
  }
});

// Odbiór nagrody
router.post("/:id/claim", (req, res) => {
  try {
    const roomId = req.params.id;
    const { claimerAddress } = req.body;
    
    if (!claimerAddress) {
      return res.status(400).json({ error: "Missing claimer address" });
    }
    
    const room = rooms.get(roomId);
    
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }
    
    // Sprawdź, czy osoba odbierająca jest zwycięzcą
    if (room.winner !== claimerAddress) {
      return res.status(403).json({ error: "Only the winner can claim the prize" });
    }
    
    // Sprawdź, czy nagroda nie została już odebrana
    if (room.prizeClaimedBy) {
      return res.status(400).json({ error: "Prize already claimed" });
    }
    
    // Oznacz nagrodę jako odebraną
    room.prizeClaimedBy = claimerAddress;
    room.prizeClaimedAt = new Date().toISOString();
    room.lastActivity = new Date().toISOString();
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error claiming prize:", error);
    res.status(500).json({ error: "Failed to claim prize" });
  }
});

// Anuluj pokój
router.post("/:id/cancel", (req, res) => {
  try {
    const roomId = req.params.id;
    const { creatorAddress } = req.body;
    
    if (!creatorAddress) {
      return res.status(400).json({ error: "Missing creator address" });
    }
    
    const room = rooms.get(roomId);
    
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }
    
    // Sprawdź, czy osoba anulująca jest twórcą
    if (room.creatorAddress !== creatorAddress) {
      return res.status(403).json({ error: "Only the creator can cancel the room" });
    }
    
    // Oznacz pokój jako nieaktywny
    room.isActive = false;
    room.cancelledAt = new Date().toISOString();
    room.lastActivity = new Date().toISOString();
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error cancelling room:", error);
    res.status(500).json({ error: "Failed to cancel room" });
  }
});

// Opuść pokój
router.post("/:id/leave", (req, res) => {
  try {
    const roomId = req.params.id;
    const { playerAddress } = req.body;
    
    if (!playerAddress) {
      return res.status(400).json({ error: "Missing player address" });
    }
    
    const room = rooms.get(roomId);
    
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }
    
    // Sprawdź, czy gracz jest w pokoju
    const playerIndex = room.players.indexOf(playerAddress);
    if (playerIndex === -1) {
      return res.status(400).json({ error: "Player is not in this room" });
    }
    
    // Zapisz, czy pokój był aktywny przed opuszczeniem
    const wasActive = room.isActive && room.gameStarted && !room.winner;
    
    // Jeśli gra jest w toku, a gracz opuszcza pokój, ustaw przeciwnika jako zwycięzcę
    if (wasActive && room.players.length === 2) {
      const opponentAddress = room.players.find(p => p !== playerAddress);
      
      room.winner = opponentAddress;
      room.isActive = false;
      room.endedAt = new Date().toISOString();
      room.opponentWins = true;
      
      res.status(200).json({ 
        success: true, 
        wasActive, 
        opponentWins: true,
        opponentAddress 
      });
    } else {
      // Jeśli gra jeszcze się nie rozpoczęła lub jest więcej graczy, po prostu usuń gracza
      room.players = room.players.filter(p => p !== playerAddress);
      
      // Jeśli to był ostatni gracz, oznacz pokój jako nieaktywny
      if (room.players.length === 0) {
        room.isActive = false;
      }
      
      room.lastActivity = new Date().toISOString();
      
      res.status(200).json({ success: true, wasActive, opponentWins: false });
    }
  } catch (error) {
    console.error("Error leaving room:", error);
    res.status(500).json({ error: "Failed to leave room" });
  }
});

module.exports = router;' > routes/rooms.js

    # Utwórz plik tras dla gry
    echo 'const express = require("express");
const router = express.Router();

// Trasy związane z samą grą
// Te trasy mogą być używane do celów administracyjnych i monitorowania

// Pobierz statystyki gier
router.get("/stats", (req, res) => {
  try {
    // W prawdziwym rozwiązaniu pobieralibyśmy statystyki z bazy danych
    const stats = {
      totalGames: 0,
      activePlayers: 0,
      totalPlayers: 0
    };
    
    res.status(200).json(stats);
  } catch (error) {
    console.error("Error getting game stats:", error);
    res.status(500).json({ error: "Failed to get game stats" });
  }
});

module.exports = router;' > routes/game.js
fi

# Kompilacja frontendu
echo -e "${BLUE}Kompilowanie frontendu...${NC}"
cd ..
npm run build

echo -e "${BLUE}======================================================${NC}"
echo -e "${GREEN}Wdrażanie zakończone! Możesz teraz uruchomić aplikację.${NC}"
echo -e "${GREEN}Program Solana ID: ${PROGRAM_ID}${NC}"
echo -e "${GREEN}Adres serwera: ${SERVER_URL}${NC}"
echo -e "${BLUE}======================================================${NC}"
echo -e "${YELLOW}Aby uruchomić serwer gry, wykonaj:${NC}"
echo -e "cd server && npm start"
echo -e "${YELLOW}Aby uruchomić frontend w trybie deweloperskim:${NC}"
echo -e "npm start"
echo -e "${BLUE}======================================================${NC}"