// Program Solana odpowiedzialny za logikę gry UNO na blockchainie - wersja hybrydowa

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    program::{invoke, invoke_signed},
    system_instruction,
    sysvar::{rent::Rent, Sysvar, clock::Clock},
};
use borsh::{BorshDeserialize, BorshSerialize};
use std::str::FromStr;

/// Definicja stanów gry
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq)]
pub enum GameStatus {
    WaitingForPlayers,
    InProgress,
    Completed,
}

/// Struktura danych pokoju (gry) - zoptymalizowana dla modelu hybrydowego
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct GameRoom {
    pub creator: Pubkey,                  // 32 bajty
    pub max_players: u8,                  // 1 bajt
    pub entry_fee_lamports: u64,          // 8 bajtów
    pub players: Vec<Pubkey>,             // 4 + (32 * max 4) = 132 bajty
    pub status: GameStatus,               // 1 bajt (enum)
    pub winner: Option<Pubkey>,           // 1 + 32 = 33 bajty
    pub created_at: i64,                  // 8 bajtów
    pub game_started_at: Option<i64>,     // 1 + 8 = 9 bajtów
    pub game_ended_at: Option<i64>,       // 1 + 8 = 9 bajtów
    pub prize_claimed: bool,              // 1 bajt
    pub game_id: [u8; 64],               // 64 bajty - stały rozmiar zamiast String
    pub room_slot: u8,                   // 1 bajt - numer slotu pokoju
}

impl GameRoom {
    pub const SIZE: usize = 512;
    pub const HEADER_SIZE: usize = 4; // Pierwsze 4 bajty przechowują rozmiar danych
    
    pub fn new(creator: Pubkey, max_players: u8, entry_fee_lamports: u64, created_at: i64, room_slot: u8) -> Self {
        Self {
            creator,
            max_players,
            entry_fee_lamports,
            players: vec![creator],
            status: GameStatus::WaitingForPlayers,
            winner: None,
            created_at,
            game_started_at: None,
            game_ended_at: None,
            prize_claimed: false,
            game_id: [0u8; 64],
            room_slot,
        }
    }
    
    // Metoda do bezpiecznej deserializacji
    pub fn from_account_data(data: &[u8]) -> Result<Self, ProgramError> {
        // Sprawdzamy czy dane mają minimalny rozmiar
        if data.len() < Self::HEADER_SIZE {
            msg!("Account data too small for header");
            return Err(ProgramError::InvalidAccountData);
        }
        
        // Odczytaj rozmiar danych z pierwszych 4 bajtów
        let size_bytes: [u8; 4] = data[..4].try_into()
            .map_err(|_| ProgramError::InvalidAccountData)?;
        let data_size = u32::from_le_bytes(size_bytes) as usize;
        
        msg!("Data size from header: {}", data_size);
        
        // Sprawdź czy mamy wystarczająco danych
        if data.len() < Self::HEADER_SIZE + data_size {
            msg!("Not enough data. Expected: {}, got: {}", Self::HEADER_SIZE + data_size, data.len());
            return Err(ProgramError::InvalidAccountData);
        }
        
        // Deserializuj dane pomijając nagłówek
        Self::try_from_slice(&data[Self::HEADER_SIZE..Self::HEADER_SIZE + data_size])
            .map_err(|e| {
                msg!("Deserialization error: {:?}", e);
                ProgramError::InvalidAccountData
            })
    }
    
    // Metoda do bezpiecznej serializacji
    pub fn to_account_data(&self, data: &mut [u8]) -> Result<(), ProgramError> {
        // Sprawdzamy czy mamy wystarczająco miejsca
        if data.len() < Self::SIZE {
            return Err(ProgramError::AccountDataTooSmall);
        }
        
        // Najpierw wyczyść cały bufor
        for byte in data.iter_mut() {
            *byte = 0;
        }
        
        // Serializuj do tymczasowego bufora
        let mut temp_buffer = Vec::new();
        self.serialize(&mut temp_buffer)?;
        
        let data_size = temp_buffer.len();
        msg!("Serialized data size: {}", data_size);
        
        // Sprawdź czy zmieści się w buforze
        if data_size + Self::HEADER_SIZE > data.len() {
            return Err(ProgramError::AccountDataTooSmall);
        }
        
        // Zapisz rozmiar danych w pierwszych 4 bajtach
        let size_bytes = (data_size as u32).to_le_bytes();
        data[..4].copy_from_slice(&size_bytes);
        
        // Zapisz dane po nagłówku
        data[Self::HEADER_SIZE..Self::HEADER_SIZE + data_size].copy_from_slice(&temp_buffer);
        
        Ok(())
    }
    
    // Dodajemy metodę pomocniczą do ustawiania game_id
    pub fn set_game_id(&mut self, id: &str) {
        let bytes = id.as_bytes();
        let len = bytes.len().min(64);
        self.game_id[..len].copy_from_slice(&bytes[..len]);
    }
    
    // Dodajemy metodę do odczytu game_id
    pub fn get_game_id(&self) -> String {
        let end = self.game_id.iter().position(|&b| b == 0).unwrap_or(64);
        String::from_utf8_lossy(&self.game_id[..end]).to_string()
    }
}

/// Instrukcje programu UNO - zaktualizowane dla modelu hybrydowego
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
        room_slot: u8,  // Dodajemy slot pokoju
    },
    
    /// Dołącza do istniejącego pokoju
    /// Accounts:
    /// 1. `[signer]` Gracz dołączający (płaci wpisowe)
    /// 2. `[writable]` PDA dla danych pokoju
    /// 3. `[]` System program
    JoinRoom,
    
    /// Rozpoczyna grę i zapisuje ID serwera off-chain
    /// Accounts:
    /// 1. `[signer]` Gracz inicjujący grę (musi być w pokoju)
    /// 2. `[writable]` PDA dla danych pokoju
    StartGame {
        game_id: String,
    },
    
    /// Kończy grę i zapisuje zwycięzcę
    /// Accounts:
    /// 1. `[signer]` Gracz lub serwer sygnalizujący koniec (musi być w pokoju)
    /// 2. `[writable]` PDA dla danych pokoju
    EndGame {
        winner: Pubkey,
    },
    
    /// Odbiera nagrodę
    /// Accounts:
    /// 1. `[signer]` Zwycięzca odbierający nagrodę
    /// 2. `[writable]` PDA dla danych pokoju
    /// 3. `[]` System program
    /// 4. `[writable]` Portfel platformy dla prowizji
    ClaimPrize,
    
    /// Anuluje pokój i zwraca wpisowe wszystkim graczom
    /// Accounts:
    /// 1. `[signer]` Twórca pokoju
    /// 2. `[writable]` PDA dla danych pokoju
    /// 3. `[]` System program
    /// + Accounts dla każdego gracza, któremu należy zwrócić wpisowe
    CancelRoom,
}

// Punkt wejścia programu
entrypoint!(process_instruction);

/// Przetwarzanie instrukcji programu
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    input: &[u8],
) -> ProgramResult {
    msg!("Program called with {} bytes of data", input.len());
    msg!("Data: {:?}", input);
    
    // Sprawdź, czy mamy wystarczająco danych
    if input.is_empty() {
        msg!("Error: No instruction data provided");
        return Err(ProgramError::InvalidInstructionData);
    }
    
    // Sprawdź pierwszy bajt (instruction tag)
    msg!("Instruction tag: {}", input[0]);
    
    let instruction = UnoInstruction::try_from_slice(input)?;
    
    match instruction {
        UnoInstruction::CreateRoom { max_players, entry_fee_lamports, room_slot } => {
            msg!("Processing CreateRoom: max_players={}, entry_fee={}, slot={}", max_players, entry_fee_lamports, room_slot);
            process_create_room(program_id, accounts, max_players, entry_fee_lamports, room_slot)
        },
        UnoInstruction::JoinRoom => {
            msg!("Processing JoinRoom");
            process_join_room(program_id, accounts)
        },
        UnoInstruction::StartGame { game_id } => {
            msg!("Processing StartGame with id: {}", game_id);
            process_start_game(program_id, accounts, game_id)
        },
        UnoInstruction::EndGame { winner } => {
            msg!("Processing EndGame with winner: {}", winner);
            process_end_game(program_id, accounts, winner)
        },
        UnoInstruction::ClaimPrize => {
            msg!("Processing ClaimPrize");
            process_claim_prize(program_id, accounts)
        },
        UnoInstruction::CancelRoom => {
            msg!("Processing CancelRoom");
            process_cancel_room(program_id, accounts)
        },
    }
}

/// Implementacja tworzenia pokoju
fn process_create_room(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    max_players: u8,
    entry_fee_lamports: u64,
    room_slot: u8,
) -> ProgramResult {
    msg!("Starting create_room with max_players: {}, entry_fee: {}, slot: {}", max_players, entry_fee_lamports, room_slot);
    
    let accounts_iter = &mut accounts.iter();
    
    let creator_account = next_account_info(accounts_iter)?;
    msg!("Creator account: {}", creator_account.key);
    
    let game_account = next_account_info(accounts_iter)?;
    msg!("Game account: {}", game_account.key);
    
    let system_program = next_account_info(accounts_iter)?;
    msg!("System program: {}", system_program.key);
    
    let rent_account = next_account_info(accounts_iter)?;
    msg!("Rent account: {}", rent_account.key);
    
    // Sprawdź, czy to rzeczywiście system program
    if *system_program.key != solana_program::system_program::ID {
        msg!("Error: Invalid system program account");
        return Err(ProgramError::InvalidArgument);
    }
    
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
    
    // Walidacja slotu (maksymalnie 10 pokojów na użytkownika)
    if room_slot >= 10 {
        msg!("Error: Invalid room slot: {}", room_slot);
        return Err(ProgramError::InvalidArgument);
    }
    
    // Weryfikacja czy konto pokoju jest prawidłowym PDA z uwzględnieniem slotu
    let (expected_game_pubkey, bump_seed) = Pubkey::find_program_address(
        &[b"uno_game", creator_account.key.as_ref(), &[room_slot]],
        program_id,
    );
    
    if expected_game_pubkey != *game_account.key {
        msg!("Error: Invalid PDA. Expected: {}, Got: {}", expected_game_pubkey, game_account.key);
        return Err(ProgramError::InvalidArgument);
    }
    
    // Obliczenie czynszu
    let rent = Rent::from_account_info(rent_account)?;
    let space = GameRoom::SIZE;
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
        &[&[b"uno_game", creator_account.key.as_ref(), &[room_slot], &[bump_seed]]],
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
    let clock = Clock::get()?;
    let current_timestamp = clock.unix_timestamp;
    
    let game_room = GameRoom::new(
        *creator_account.key,
        max_players,
        entry_fee_lamports,
        current_timestamp,
        room_slot,
    );
    
    // Serializacja i zapisanie danych
    game_room.to_account_data(&mut game_account.data.borrow_mut())?;
    
    msg!("Utworzono nowy pokój gry UNO w slocie {}", room_slot);
    Ok(())
}

/// Implementacja dołączania do pokoju
fn process_join_room(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    
    let player_account = next_account_info(accounts_iter)?;
    let game_account = next_account_info(accounts_iter)?;
    let system_program = next_account_info(accounts_iter)?;
    
    msg!("Join room - Player: {}", player_account.key);
    msg!("Join room - Game account: {}", game_account.key);
    
    // Weryfikacja podpisu
    if !player_account.is_signer {
        msg!("Error: Missing required signature");
        return Err(ProgramError::MissingRequiredSignature);
    }
    
    // Sprawdzenie rozmiaru konta przed deserializacją
    msg!("Game account data length: {}", game_account.data_len());
    
    // Wczytanie danych pokoju
    let mut game_room = GameRoom::from_account_data(&game_account.data.borrow())?;
    
    msg!("Game room loaded successfully");
    msg!("Current players: {:?}", game_room.players);
    msg!("Entry fee: {}", game_room.entry_fee_lamports);
    
    // Sprawdzenie stanu pokoju
    if game_room.status != GameStatus::WaitingForPlayers {
        msg!("Error: Room is not waiting for players");
        return Err(ProgramError::InvalidAccountData);
    }
    
    // Sprawdzenie czy gracz już jest w pokoju
    if game_room.players.contains(player_account.key) {
        msg!("Error: Player already in room");
        return Err(ProgramError::InvalidArgument);
    }
    
    // Sprawdzenie czy pokój nie jest już pełny
    if game_room.players.len() >= game_room.max_players as usize {
        msg!("Error: Room is full");
        return Err(ProgramError::InvalidArgument);
    }
    
    msg!("Transferring entry fee: {} lamports", game_room.entry_fee_lamports);
    
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
    
    msg!("Entry fee transferred successfully");
    
    // Dodanie gracza do listy
    game_room.players.push(*player_account.key);
    
    msg!("Player added to room. Total players: {}", game_room.players.len());
    
    // Zapisanie zaktualizowanych danych
    game_room.to_account_data(&mut game_account.data.borrow_mut())?;
    
    msg!("Dołączono do pokoju gry UNO");
    Ok(())
}

/// Implementacja rozpoczęcia gry
fn process_start_game(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    game_id: String,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    
    let initiator_account = next_account_info(accounts_iter)?;
    let game_account = next_account_info(accounts_iter)?;
    
    // Weryfikacja podpisu
    if !initiator_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    
    // Wczytanie danych pokoju
    let mut game_room = GameRoom::from_account_data(&game_account.data.borrow())?;
    
    // Sprawdzenie czy osoba inicjująca jest w pokoju
    if !game_room.players.contains(initiator_account.key) {
        return Err(ProgramError::InvalidArgument);
    }
    
    // Sprawdzenie stanu pokoju
    if game_room.status != GameStatus::WaitingForPlayers {
        return Err(ProgramError::InvalidAccountData);
    }
    
    // Sprawdzenie minimalnej liczby graczy
    if game_room.players.len() < 2 {
        return Err(ProgramError::InvalidArgument);
    }
    
    // Ustawienie statusu gry i zapisanie ID gry off-chain
    game_room.status = GameStatus::InProgress;
    game_room.set_game_id(&game_id);
    
    // Zapisanie czasu rozpoczęcia
    let clock = Clock::get()?;
    game_room.game_started_at = Some(clock.unix_timestamp);
    
    // Zapisanie zaktualizowanych danych
    game_room.to_account_data(&mut game_account.data.borrow_mut())?;
    
    msg!("Gra UNO rozpoczęta. Off-chain ID: {}", game_room.get_game_id());
    Ok(())
}

/// Implementacja zakończenia gry
fn process_end_game(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    winner: Pubkey,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    
    let initiator_account = next_account_info(accounts_iter)?;
    let game_account = next_account_info(accounts_iter)?;
    
    // Weryfikacja podpisu
    if !initiator_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    
    // Wczytanie danych pokoju
    let mut game_room = GameRoom::from_account_data(&game_account.data.borrow())?;
    
    // Sprawdzenie czy osoba inicjująca jest w pokoju lub jest twórcą
    let is_player = game_room.players.contains(initiator_account.key);
    let is_creator = game_room.creator == *initiator_account.key;
    
    if !is_player && !is_creator {
        return Err(ProgramError::InvalidArgument);
    }
    
    // Sprawdzenie stanu pokoju
    if game_room.status != GameStatus::InProgress {
        return Err(ProgramError::InvalidAccountData);
    }
    
    // Sprawdzenie czy zwycięzca jest jednym z graczy
    if !game_room.players.contains(&winner) {
        return Err(ProgramError::InvalidArgument);
    }
    
    // Ustawienie zakończenia gry i zwycięzcy
    game_room.status = GameStatus::Completed;
    game_room.winner = Some(winner);
    
    // Zapisanie czasu zakończenia
    let clock = Clock::get()?;
    game_room.game_ended_at = Some(clock.unix_timestamp);
    
    // Zapisanie zaktualizowanych danych
    game_room.to_account_data(&mut game_account.data.borrow_mut())?;
    
    msg!("Gra UNO zakończona. Zwycięzca: {}", winner);
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
    let _system_program = next_account_info(accounts_iter)?;
    let platform_fee_account = next_account_info(accounts_iter)?; // NOWE: Konto dla prowizji platformy
    
    msg!("Claim prize - Winner account: {}", winner_account.key);
    msg!("Claim prize - Game account: {}", game_account.key);
    msg!("Claim prize - Platform fee account: {}", platform_fee_account.key);
    
    // STAŁY ADRES PORTFELA PLATFORMY - ZMIEŃ NA SWÓJ!
    const PLATFORM_WALLET: &str = "FEEfBE29dqRgC8qMv6f9YXTSNbX7LMN3Reo3UsYdoUd8";
    let platform_pubkey = Pubkey::from_str(PLATFORM_WALLET).unwrap_or_default();
    
    // Weryfikacja, że podano prawidłowy adres platformy
    if *platform_fee_account.key != platform_pubkey {
        msg!("Error: Invalid platform fee account");
        return Err(ProgramError::InvalidArgument);
    }
    
    // Weryfikacja podpisu
    if !winner_account.is_signer {
        msg!("Error: Winner account is not a signer");
        return Err(ProgramError::MissingRequiredSignature);
    }
    
    // Sprawdź czy game_account należy do naszego programu
    if game_account.owner != program_id {
        msg!("Error: Game account is not owned by this program");
        return Err(ProgramError::IncorrectProgramId);
    }
    
    // Wczytanie danych pokoju
    let mut game_room = GameRoom::from_account_data(&game_account.data.borrow())?;
    
    msg!("Game room loaded. Status: {:?}", game_room.status);
    msg!("Winner in game room: {:?}", game_room.winner);
    msg!("Prize already claimed: {}", game_room.prize_claimed);
    
    // Sprawdzenie stanu gry
    if game_room.status != GameStatus::Completed {
        msg!("Error: Game is not completed. Current status: {:?}", game_room.status);
        return Err(ProgramError::InvalidAccountData);
    }
    
    // Sprawdzenie czy gracz jest zwycięzcą
    if game_room.winner != Some(*winner_account.key) {
        msg!("Error: Claimer is not the winner. Winner: {:?}, Claimer: {}", 
            game_room.winner, winner_account.key);
        return Err(ProgramError::InvalidArgument);
    }
    
    // Sprawdzenie czy nagroda nie została już odebrana
    if game_room.prize_claimed {
        msg!("Error: Prize already claimed");
        return Err(ProgramError::InvalidAccountData);
    }
    
    // Obliczenie całkowitej puli
    let total_prize = game_room.entry_fee_lamports * game_room.players.len() as u64;
    msg!("Total prize pool: {} lamports", total_prize);
    
    // Obliczenie prowizji platformy (5%)
    let platform_fee = total_prize * 5 / 100; // 5% prowizji
    let winner_prize = total_prize - platform_fee;
    
    msg!("Platform fee (5%): {} lamports", platform_fee);
    msg!("Winner prize (95%): {} lamports", winner_prize);
    
    // Sprawdź czy konto ma wystarczające środki
    let rent = Rent::get()?;
    let rent_exempt_balance = rent.minimum_balance(game_account.data_len());
    let available_balance = game_account.lamports().saturating_sub(rent_exempt_balance);
    
    msg!("Game account balance: {} lamports", game_account.lamports());
    msg!("Rent exempt balance: {} lamports", rent_exempt_balance);
    msg!("Available for distribution: {} lamports", available_balance);
    
    if available_balance < total_prize {
        msg!("Error: Insufficient funds in game account. Available: {}, needs: {}", 
            available_balance, total_prize);
        return Err(ProgramError::InsufficientFunds);
    }
    
    // Transfer prowizji do portfela platformy
    if platform_fee > 0 {
        msg!("Transferring platform fee: {} lamports", platform_fee);
        **game_account.try_borrow_mut_lamports()? = game_account.lamports().saturating_sub(platform_fee);
        **platform_fee_account.try_borrow_mut_lamports()? = platform_fee_account.lamports().saturating_add(platform_fee);
    }
    
    // Transfer nagrody do zwycięzcy
    msg!("Transferring winner prize: {} lamports", winner_prize);
    **game_account.try_borrow_mut_lamports()? = game_account.lamports().saturating_sub(winner_prize);
    **winner_account.try_borrow_mut_lamports()? = winner_account.lamports().saturating_add(winner_prize);
    
    msg!("All transfers completed successfully");
    
    // Oznaczenie nagrody jako odebranej
    game_room.prize_claimed = true;
    
    // Zapisanie zaktualizowanych danych
    game_room.to_account_data(&mut game_account.data.borrow_mut())?;
    
    msg!("Prize claimed. Platform fee: {} lamports, Winner prize: {} lamports", platform_fee, winner_prize);
    Ok(())
}

/// Implementacja anulowania pokoju
fn process_cancel_room(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    
    let creator_account = next_account_info(accounts_iter)?;
    let game_account = next_account_info(accounts_iter)?;
    let system_program = next_account_info(accounts_iter)?;
    
    // Weryfikacja podpisu
    if !creator_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    
    // Wczytanie danych pokoju
    let game_room = GameRoom::from_account_data(&game_account.data.borrow())?;
    
    // Sprawdzenie czy osoba wywołująca jest twórcą
    if game_room.creator != *creator_account.key {
        return Err(ProgramError::InvalidArgument);
    }
    
    // Sprawdzenie stanu pokoju (można anulować tylko oczekujący pokój)
    if game_room.status != GameStatus::WaitingForPlayers {
        return Err(ProgramError::InvalidAccountData);
    }
    
    // Przygotowanie sygnatury PDA
    let seeds = &[b"uno_game", game_room.creator.as_ref(), &[game_room.room_slot]];
    let (_, bump_seed) = Pubkey::find_program_address(seeds, program_id);
    let signer_seeds = &[b"uno_game", game_room.creator.as_ref(), &[game_room.room_slot], &[bump_seed]];
    
    // Zwrot wpisowego każdemu graczowi
    let mut remaining_accounts_iter = accounts_iter.clone();
    for player_pubkey in &game_room.players {
        // Sprawdź, czy to nie jest twórca (już ma swoje konto)
        if *player_pubkey != game_room.creator {
            // Pobierz konto gracza z przekazanych kont
            let player_account = next_account_info(&mut remaining_accounts_iter)?;
            
            // Sprawdź, czy konto odpowiada kluczowi publicznemu
            if *player_account.key != *player_pubkey {
                return Err(ProgramError::InvalidArgument);
            }
            
            // Zwróć wpisowe
            invoke_signed(
                &system_instruction::transfer(
                    game_account.key,
                    player_account.key,
                    game_room.entry_fee_lamports,
                ),
                &[
                    game_account.clone(),
                    player_account.clone(),
                    system_program.clone(),
                ],
                &[signer_seeds],
            )?;
        }
    }
    
    // Zwróć resztę środków (w tym wpisowe twórcy) do twórcy
    let remaining_lamports = game_account.lamports();
    **game_account.lamports.borrow_mut() = 0;
    **creator_account.lamports.borrow_mut() += remaining_lamports;
    
    msg!("Pokój UNO anulowany. Zwrócono wpisowe wszystkim graczom.");
    Ok(())
}