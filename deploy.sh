#!/bin/bash
# Skrypt do testowania i wdrażania programu Solana UNO

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
        ;;
    3)
        NETWORK="mainnet-beta"
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

# Przejdź do katalogu programu
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
    echo -e "${GREEN}ID programu zapisane w pliku .env.local${NC}"
    
    # Instrukcje aktualizacji frontendu
    echo -e "${YELLOW}Pamiętaj, aby zaktualizować PROGRAM_ID w pliku src/utils/SolanaTransactions.js:${NC}"
    echo -e "const PROGRAM_ID = new PublicKey('${PROGRAM_ID}');"
fi

echo -e "${BLUE}======================================================${NC}"
echo -e "${GREEN}Wdrażanie zakończone! Możesz teraz uruchomić aplikację.${NC}"
echo -e "${BLUE}======================================================${NC}"