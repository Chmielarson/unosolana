// Program Solana odpowiedzialny za logikę gry UNO na blockchainie

// src/program/uno_program.rs
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    program::{invoke, invoke_signed},
    system_instruction,
    sysvar::{rent::Rent, Sysvar},
};
use borsh::{BorshDeserialize, BorshSerialize};
use std::collections::HashMap;

/// Definicja stanów gry
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq)]
pub enum GameStatus {
    WaitingForPlayers,
    InProgress,
    Completed,
}

/// Definicja karty UNO
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq)]
pub struct UnoCard {
    pub color: String, // "red", "blue", "green", "yellow", "black"
    pub value: String, // "0"-"9", "Skip", "Reverse", "Draw2", "Wild", "Wild4"
}

/// Struktura danych pokoju (gry)
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct GameRoom {
    pub creator: Pubkey,
    pub max_players: u8,
    pub entry_fee_lamports: u64,
    pub players: Vec<Pubkey>,
    pub status: GameStatus,
    pub winner: Option<Pubkey>,
    pub current_player_index: u8,
    pub direction: i8, // 1 zgodnie z ruchem wskazówek zegara, -1 przeciwnie
    pub current_card: Option<UnoCard>,
    pub player_hands: HashMap<Pubkey, Vec<UnoCard>>,
    pub deck: Vec<UnoCard>,
    pub created_at: i64,
    pub game_started_at: Option<i64>,
    pub game_ended_at: Option<i64>,
    pub prize_claimed: bool,
}

impl GameRoom {
    pub fn new(creator: Pubkey, max_players: u8, entry_fee_lamports: u64, created_at: i64) -> Self {
        Self {
            creator,
            max_players,
            entry_fee_lamports,
            players: vec![creator],
            status: GameStatus::WaitingForPlayers,
            winner: None,
            current_player_index: 0,
            direction: 1,
            current_card: None,
            player_hands: HashMap::new(),
            deck: Vec::new(),
            created_at,
            game_started_at: None,
            game_ended_at: None,
            prize_claimed: false,
        }
    }
}

/// Instrukcje programu UNO
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub enum UnoInstruction {
    /// Tworzy nowy pokój gry
    /// Accounts:
    /// 1. `[signer]` Twórca pokoju (płaci wpisowe)
    /// 2. `[writable]` PDA dla danych pokoju
    /// 3. `[]` System program
    /// 4. `[]` Rent sysvar
    CreateRoom {
        max_players: u8,
        entry_fee_lamports: u64,
    },
    
    /// Dołącza do istniejącego pokoju
    /// Accounts:
    /// 1. `[signer]` Gracz dołączający (płaci wpisowe)
    /// 2. `[writable]` PDA dla danych pokoju
    /// 3. `[]` System program
    JoinRoom,
    
    /// Zagrywa kartę
    /// Accounts:
    /// 1. `[signer]` Gracz zagrywający kartę
    /// 2. `[writable]` PDA dla danych pokoju
    PlayCard {
        card_index: u8,
        chosen_color: Option<String>, // Dla kart Wild
    },
    
    /// Dobiera kartę
    /// Accounts:
    /// 1. `[signer]` Gracz dobierający kartę
    /// 2. `[writable]` PDA dla danych pokoju
    DrawCard,
    
    /// Odbiera nagrodę
    /// Accounts:
    /// 1. `[signer]` Zwycięzca odbierający nagrodę
    /// 2. `[writable]` PDA dla danych pokoju
    /// 3. `[]` System program
    ClaimPrize,
}

// Punkt wejścia programu
entrypoint!(process_instruction);

/// Przetwarzanie instrukcji programu
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    input: &[u8],
) -> ProgramResult {
    let instruction = UnoInstruction::try_from_slice(input)?;
    
    match instruction {
        UnoInstruction::CreateRoom { max_players, entry_fee_lamports } => {
            process_create_room(program_id, accounts, max_players, entry_fee_lamports)
        },
        UnoInstruction::JoinRoom => {
            process_join_room(program_id, accounts)
        },
        UnoInstruction::PlayCard { card_index, chosen_color } => {
            process_play_card(program_id, accounts, card_index, chosen_color)
        },
        UnoInstruction::DrawCard => {
            process_draw_card(program_id, accounts)
        },
        UnoInstruction::ClaimPrize => {
            process_claim_prize(program_id, accounts)
        },
    }
}

/// Implementacja tworzenia pokoju
fn process_create_room(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    max_players: u8,
    entry_fee_lamports: u64,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    
    let creator_account = next_account_info(accounts_iter)?;
    let game_account = next_account_info(accounts_iter)?;
    let system_program = next_account_info(accounts_iter)?;
    let rent_account = next_account_info(accounts_iter)?;
    
    // Weryfikacja podpisu
    if !creator_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    
    // Walidacja parametrów
    if max_players < 2 || max_players > 4 {
        return Err(ProgramError::InvalidArgument);
    }
    
    if entry_fee_lamports == 0 {
        return Err(ProgramError::InvalidArgument);
    }
    
    // Weryfikacja czy konto pokoju jest prawidłowym PDA
    let (expected_game_pubkey, bump_seed) = Pubkey::find_program_address(
        &[b"uno_game", creator_account.key.as_ref()],
        program_id,
    );
    
    if expected_game_pubkey != *game_account.key {
        return Err(ProgramError::InvalidArgument);
    }
    
    // Obliczenie czynszu
    let rent = Rent::from_account_info(rent_account)?;
    let space = 1000; // Orientacyjny rozmiar danych pokoju
    let lamports = rent.minimum_balance(space);
    
    // Utworzenie konta PDA
    invoke_signed(
        &system_instruction::create_account(
            creator_account.key,
            game_account.key,
            lamports,
            space as u64,
            program_id,
        ),
        &[
            creator_account.clone(),
            game_account.clone(),
            system_program.clone(),
        ],
        &[&[b"uno_game", creator_account.key.as_ref(), &[bump_seed]]],
    )?;
    
    // Transfer wpisowego
    invoke(
        &system_instruction::transfer(
            creator_account.key,
            game_account.key,
            entry_fee_lamports,
        ),
        &[
            creator_account.clone(),
            game_account.clone(),
            system_program.clone(),
        ],
    )?;
    
    // Inicjalizacja danych pokoju
    let current_timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    
    let game_room = GameRoom::new(
        *creator_account.key,
        max_players,
        entry_fee_lamports,
        current_timestamp,
    );
    
    // Serializacja i zapisanie danych
    game_room.serialize(&mut *game_account.data.borrow_mut())?;
    
    msg!("Utworzono nowy pokój gry UNO");
    Ok(())
}

/// Implementacja dołączania do pokoju
fn process_join_room(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    
    let player_account = next_account_info(accounts_iter)?;
    let game_account = next_account_info(accounts_iter)?;
    let system_program = next_account_info(accounts_iter)?;
    
    // Weryfikacja podpisu
    if !player_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    
    // Wczytanie danych pokoju
    let mut game_room = GameRoom::try_from_slice(&game_account.data.borrow())?;
    
    // Sprawdzenie stanu pokoju
    if game_room.status != GameStatus::WaitingForPlayers {
        return Err(ProgramError::InvalidAccountData);
    }
    
    // Sprawdzenie czy gracz już jest w pokoju
    if game_room.players.contains(player_account.key) {
        return Err(ProgramError::InvalidArgument);
    }
    
    // Sprawdzenie czy pokój nie jest już pełny
    if game_room.players.len() >= game_room.max_players as usize {
        return Err(ProgramError::InvalidArgument);
    }
    
    // Transfer wpisowego
    invoke(
        &system_instruction::transfer(
            player_account.key,
            game_account.key,
            game_room.entry_fee_lamports,
        ),
        &[
            player_account.clone(),
            game_account.clone(),
            system_program.clone(),
        ],
    )?;
    
    // Dodanie gracza do listy
    game_room.players.push(*player_account.key);
    
    // Jeśli pokój jest pełny, rozpocznij grę
    if game_room.players.len() >= game_room.max_players as usize {
        start_game(&mut game_room)?;
    }
    
    // Zapisanie zaktualizowanych danych
    game_room.serialize(&mut *game_account.data.borrow_mut())?;
    
    msg!("Dołączono do pokoju gry UNO");
    Ok(())
}

/// Funkcja pomocnicza do rozpoczęcia gry
fn start_game(game_room: &mut GameRoom) -> ProgramResult {
    // Ustawienie statusu gry
    game_room.status = GameStatus::InProgress;
    
    // Zapisz czas rozpoczęcia
    let current_timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    
    game_room.game_started_at = Some(current_timestamp);
    
    // Tworzenie i tasowanie talii
    game_room.deck = create_shuffled_deck();
    
    // Rozdanie kart graczom
    for player in &game_room.players {
        let mut hand = Vec::new();
        for _ in 0..7 {
            if let Some(card) = game_room.deck.pop() {
                hand.push(card);
            }
        }
        game_room.player_hands.insert(*player, hand);
    }
    
    // Wyłożenie pierwszej karty
    if let Some(card) = game_room.deck.pop() {
        // Jeśli pierwsza karta to Wild, wybierz losowy kolor
        if card.color == "black" {
            let colors = ["red", "blue", "green", "yellow"];
            let random_color = colors[game_room.deck.len() % 4].to_string();
            
            game_room.current_card = Some(UnoCard {
                color: random_color,
                value: card.value,
            });
        } else {
            game_room.current_card = Some(card);
        }
    }
    
    // Ustawienie pierwszego gracza
    game_room.current_player_index = 0;
    
    msg!("Gra UNO rozpoczęta");
    Ok(())
}

/// Funkcja pomocnicza do tworzenia i tasowania talii kart UNO
fn create_shuffled_deck() -> Vec<UnoCard> {
    let colors = ["red", "blue", "green", "yellow"];
    let values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "Skip", "Reverse", "Draw2"];
    
    let mut deck = Vec::new();
    
    // Dodanie kart kolorowych
    for color in &colors {
        for value in &values {
            deck.push(UnoCard {
                color: color.to_string(),
                value: value.to_string(),
            });
            
            // Każda karta występuje dwa razy, z wyjątkiem 0
            if *value != "0" {
                deck.push(UnoCard {
                    color: color.to_string(),
                    value: value.to_string(),
                });
            }
        }
    }
    
    // Dodanie kart Wild i Wild4
    for _ in 0..4 {
        deck.push(UnoCard {
            color: "black".to_string(),
            value: "Wild".to_string(),
        });
        
        deck.push(UnoCard {
            color: "black".to_string(),
            value: "Wild4".to_string(),
        });
    }
    
    // Tasowanie talii
    // Implementacja Fisher-Yates shuffle
    let mut rng = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as usize;
    
    for i in (1..deck.len()).rev() {
        // Proste generowanie losowej liczby
        rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
        let j = rng % (i + 1);
        
        // Zamiana elementów
        deck.swap(i, j);
    }
    
    deck
}

/// Implementacja zagrywania karty
fn process_play_card(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    card_index: u8,
    chosen_color: Option<String>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    
    let player_account = next_account_info(accounts_iter)?;
    let game_account = next_account_info(accounts_iter)?;
    
    // Weryfikacja podpisu
    if !player_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    
    // Wczytanie danych pokoju
    let mut game_room = GameRoom::try_from_slice(&game_account.data.borrow())?;
    
    // Sprawdzenie stanu gry
    if game_room.status != GameStatus::InProgress {
        return Err(ProgramError::InvalidAccountData);
    }
    
    // Sprawdzenie czy to kolej gracza
    let player_index = game_room.players.iter().position(|pubkey| pubkey == player_account.key)
        .ok_or(ProgramError::InvalidArgument)?;
    
    if player_index as u8 != game_room.current_player_index {
        return Err(ProgramError::InvalidArgument);
    }
    
    // Pobranie ręki gracza
    let player_hand = game_room.player_hands.get_mut(player_account.key)
        .ok_or(ProgramError::InvalidAccountData)?;
    
    // Sprawdzenie czy indeks karty jest prawidłowy
    if card_index as usize >= player_hand.len() {
        return Err(ProgramError::InvalidArgument);
    }
    
    // Pobranie karty i sprawdzenie czy jest dozwolona
    let card = &player_hand[card_index as usize];
    let current_card = game_room.current_card.as_ref()
        .ok_or(ProgramError::InvalidAccountData)?;
    
    if !is_valid_move(card, current_card) {
        return Err(ProgramError::InvalidArgument);
    }
    
    // Zagranie karty
    let played_card = player_hand.remove(card_index as usize);
    
    // Obsługa efektów specjalnych kart
    if played_card.color == "black" {
        // Dla kart Wild wymagamy wybrania koloru
        if let Some(color) = chosen_color {
            if !["red", "blue", "green", "yellow"].contains(&color.as_str()) {
                return Err(ProgramError::InvalidArgument);
            }
            
            // Ustaw nowy kolor
            game_room.current_card = Some(UnoCard {
                color,
                value: played_card.value.clone(),
            });
            
            // Efekt Wild Draw 4
            if played_card.value == "Wild4" {
                let next_player_index = get_next_player_index(&game_room);
                let next_player = game_room.players[next_player_index as usize];
                
                // Dobierz 4 karty dla następnego gracza
                let next_player_hand = game_room.player_hands.get_mut(&next_player)
                    .ok_or(ProgramError::InvalidAccountData)?;
                
                for _ in 0..4 {
                    if let Some(card) = game_room.deck.pop() {
                        next_player_hand.push(card);
                    }
                }
            }
        } else {
            return Err(ProgramError::InvalidArgument);
        }
    } else {
        // Zwykła karta kolorowa
        game_room.current_card = Some(played_card.clone());
        
        // Obsługa kart specjalnych
        match played_card.value.as_str() {
            "Skip" => {
                // Pomiń następnego gracza
                game_room.current_player_index = get_next_player_index(&game_room);
            },
            "Reverse" => {
                // Zmień kierunek gry
                game_room.direction *= -1;
                
                // Dla 2 graczy działa jak Skip
                if game_room.players.len() == 2 {
                    game_room.current_player_index = get_next_player_index(&game_room);
                }
            },
            "Draw2" => {
                // Następny gracz dobiera 2 karty
                let next_player_index = get_next_player_index(&game_room);
                let next_player = game_room.players[next_player_index as usize];
                
                let next_player_hand = game_room.player_hands.get_mut(&next_player)
                    .ok_or(ProgramError::InvalidAccountData)?;
                
                for _ in 0..2 {
                    if let Some(card) = game_room.deck.pop() {
                        next_player_hand.push(card);
                    }
                }
            },
            _ => {}
        }
    }
    
    // Sprawdź czy gracz wygrał
    if player_hand.is_empty() {
        // Koniec gry
        game_room.status = GameStatus::Completed;
        game_room.winner = Some(*player_account.key);
        
        // Zapisz czas zakończenia
        let current_timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        
        game_room.game_ended_at = Some(current_timestamp);
    } else {
        // Przejdź do następnego gracza (jeśli nie była to karta Skip lub Reverse)
        if played_card.value != "Skip" && played_card.value != "Reverse" {
            game_room.current_player_index = get_next_player_index(&game_room);
        }
    }
    
    // Zapisanie zaktualizowanych danych
    game_room.serialize(&mut *game_account.data.borrow_mut())?;
    
    msg!("Zagranie karty UNO");
    Ok(())
}

/// Funkcja pomocnicza do sprawdzania, czy ruch jest prawidłowy
fn is_valid_move(card: &UnoCard, current_card: &UnoCard) -> bool {
    // Karta Wild zawsze może być zagrana
    if card.color == "black" {
        return true;
    }
    
    // Zgodność koloru lub wartości
    card.color == current_card.color || card.value == current_card.value
}

/// Funkcja pomocnicza do obliczenia indeksu następnego gracza
fn get_next_player_index(game_room: &GameRoom) -> u8 {
    let players_count = game_room.players.len() as u8;
    let next_index = (game_room.current_player_index as i16 + game_room.direction as i16) % players_count as i16;
    
    // Obsługa ujemnych indeksów
    if next_index < 0 {
        (next_index + players_count as i16) as u8
    } else {
        next_index as u8
    }
}

/// Implementacja dobierania karty
fn process_draw_card(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    
    let player_account = next_account_info(accounts_iter)?;
    let game_account = next_account_info(accounts_iter)?;
    
    // Weryfikacja podpisu
    if !player_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    
    // Wczytanie danych pokoju
    let mut game_room = GameRoom::try_from_slice(&game_account.data.borrow())?;
    
    // Sprawdzenie stanu gry
    if game_room.status != GameStatus::InProgress {
        return Err(ProgramError::InvalidAccountData);
    }
    
    // Sprawdzenie czy to kolej gracza
    let player_index = game_room.players.iter().position(|pubkey| pubkey == player_account.key)
        .ok_or(ProgramError::InvalidArgument)?;
    
    if player_index as u8 != game_room.current_player_index {
        return Err(ProgramError::InvalidArgument);
    }
    
    // Pobranie ręki gracza
    let player_hand = game_room.player_hands.get_mut(player_account.key)
        .ok_or(ProgramError::InvalidAccountData)?;
    
    // Dobranie karty z talii
    if let Some(card) = game_room.deck.pop() {
        player_hand.push(card);
    } else {
        // Jeśli talia jest pusta, przetasuj stos kart odrzuconych
        // W uproszczonej wersji po prostu sygnalizujemy błąd
        return Err(ProgramError::InsufficientFunds);
    }
    
    // Przejście do następnego gracza
    game_room.current_player_index = get_next_player_index(&game_room);
    
    // Zapisanie zaktualizowanych danych
    game_room.serialize(&mut *game_account.data.borrow_mut())?;
    
    msg!("Dobrano kartę UNO");
    Ok(())
}

/// Implementacja odbierania nagrody
fn process_claim_prize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    
    let winner_account = next_account_info(accounts_iter)?;
    let game_account = next_account_info(accounts_iter)?;
    let system_program = next_account_info(accounts_iter)?;
    
    // Weryfikacja podpisu
    if !winner_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    
    // Wczytanie danych pokoju
    let mut game_room = GameRoom::try_from_slice(&game_account.data.borrow())?;
    
    // Sprawdzenie stanu gry
    if game_room.status != GameStatus::Completed {
        return Err(ProgramError::InvalidAccountData);
    }
    
    // Sprawdzenie czy gracz jest zwycięzcą
    if game_room.winner != Some(*winner_account.key) {
        return Err(ProgramError::InvalidArgument);
    }
    
    // Sprawdzenie czy nagroda nie została już odebrana
    if game_room.prize_claimed {
        return Err(ProgramError::InvalidAccountData);
    }
    
    // Obliczenie nagrody (suma wszystkich wpisowych)
    let prize = game_room.entry_fee_lamports * game_room.players.len() as u64;
    
    // Przelew nagrody
    let seeds = &[b"uno_game", game_room.creator.as_ref()];
    let (_, bump_seed) = Pubkey::find_program_address(seeds, program_id);
    let signer_seeds = &[b"uno_game", game_room.creator.as_ref(), &[bump_seed]];
    
    invoke_signed(
        &system_instruction::transfer(
            game_account.key,
            winner_account.key,
            prize,
        ),
        &[
            game_account.clone(),
            winner_account.clone(),
            system_program.clone(),
        ],
        &[signer_seeds],
    )?;
    
    // Oznaczenie nagrody jako odebranej
    game_room.prize_claimed = true;
    
    // Zapisanie zaktualizowanych danych
    game_room.serialize(&mut *game_account.data.borrow_mut())?;
    
    msg!("Nagroda odebrana: {} lamports", prize);
    Ok(())
}