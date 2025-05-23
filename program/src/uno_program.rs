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
    clock::UnixTimestamp,
};
use borsh::{BorshDeserialize, BorshSerialize};

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
            created_at,
            game_started_at: None,
            game_ended_at: None,
            prize_claimed: false,
            game_id: [0u8; 64], // Inicjalizacja pustą tablicą
        }
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
        UnoInstruction::CreateRoom { max_players, entry_fee_lamports } => {
            msg!("Processing CreateRoom: max_players={}, entry_fee={}", max_players, entry_fee_lamports);
            process_create_room(program_id, accounts, max_players, entry_fee_lamports)
        },
        UnoInstruction::JoinRoom => {
            process_join_room(program_id, accounts)
        },
        UnoInstruction::StartGame { game_id } => {
            process_start_game(program_id, accounts, game_id)
        },
        UnoInstruction::EndGame { winner } => {
            process_end_game(program_id, accounts, winner)
        },
        UnoInstruction::ClaimPrize => {
            process_claim_prize(program_id, accounts)
        },
        UnoInstruction::CancelRoom => {
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
) -> ProgramResult {
    msg!("Starting create_room with max_players: {}, entry_fee: {}", max_players, entry_fee_lamports);
    
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
    let space = 512; // Zwiększony rozmiar dla bezpieczeństwa
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
    // Użyj Clock sysvar zamiast std::time
    let clock = Clock::get()?;
    let current_timestamp = clock.unix_timestamp;
    
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
    _program_id: &Pubkey,  // Dodano podkreślenie
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
    
    // Sprawdzenie rozmiaru konta przed deserializacją
    msg!("Game account data length: {}", game_account.data_len());
    
    // Wczytanie danych pokoju
    let mut game_room = match GameRoom::try_from_slice(&game_account.data.borrow()) {
        Ok(room) => room,
        Err(e) => {
            msg!("Failed to deserialize game room: {:?}", e);
            return Err(ProgramError::InvalidAccountData);
        }
    };
    
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
    
    // Zapisanie zaktualizowanych danych
    game_room.serialize(&mut *game_account.data.borrow_mut())?;
    
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
    let mut game_room = GameRoom::try_from_slice(&game_account.data.borrow())?;
    
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
    game_room.serialize(&mut *game_account.data.borrow_mut())?;
    
    msg!("Gra UNO rozpoczęta. Off-chain ID: {}", game_room.get_game_id());
    Ok(())
}

/// Implementacja zakończenia gry
fn process_end_game(
    program_id: &Pubkey,
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
    let mut game_room = GameRoom::try_from_slice(&game_account.data.borrow())?;
    
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
    game_room.serialize(&mut *game_account.data.borrow_mut())?;
    
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

/// Implementacja anulowania pokoju
fn process_cancel_room(
    program_id: &Pubkey,  // Poprawiono - usunięto podkreślenie (parametr jest używany)
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
    let game_room = GameRoom::try_from_slice(&game_account.data.borrow())?;
    
    // Sprawdzenie czy osoba wywołująca jest twórcą
    if game_room.creator != *creator_account.key {
        return Err(ProgramError::InvalidArgument);
    }
    
    // Sprawdzenie stanu pokoju (można anulować tylko oczekujący pokój)
    if game_room.status != GameStatus::WaitingForPlayers {
        return Err(ProgramError::InvalidAccountData);
    }
    
    // Przygotowanie sygnatury PDA
    let seeds = &[b"uno_game", game_room.creator.as_ref()];
    let (_, bump_seed) = Pubkey::find_program_address(seeds, program_id);
    let signer_seeds = &[b"uno_game", game_room.creator.as_ref(), &[bump_seed]];
    
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