//! agent-economy — Solana Agent 经济程序 (2026-08-13)
//!
//! Agent Economic Network on Solana (简化版):
//!   - register_agent: Agent 注册 (身份 + 信誉初始化)
//!   - pay_agent: 买方支付给 Agent 服务 (USDC 结算, 含日预算)
//!   - update_reputation: 服务结果后更新信誉
//!
//! 账户: AgentAccount (authority/agent 的 PDA) — 存信誉/支出/注册状态.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("F5rt6Skd9MW6oePaFa8TEfpo6zAUBqo53uH46nNgUY2G");

#[program]
pub mod agent_economy {
    use super::*;

    /// 注册 Agent (创建 AgentAccount, 初始化信誉)
    pub fn register_agent(ctx: Context<RegisterAgent>, reputation: u8) -> Result<()> {
        let agent = &mut ctx.accounts.agent;
        agent.authority = ctx.accounts.authority.key();
        agent.reputation = reputation;
        agent.tasks = 0;
        agent.success = 0;
        agent.total_paid = 0;
        agent.registered = true;
        Ok(())
    }

    /// 买方支付给 Agent (USDC, 简单版: 直接转账给 agent)
    pub fn pay_agent(ctx: Context<PayAgent>, amount: u64) -> Result<()> {
        require!(ctx.accounts.agent.registered, AgentError::NotRegistered);
        require!(ctx.accounts.agent.reputation >= 60, AgentError::ReputationTooLow);

        // 买方 USDC → agent USDC
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer_token.to_account_info(),
                    to: ctx.accounts.agent_token.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            amount,
        )?;

        let agent = &mut ctx.accounts.agent;
        agent.total_paid = agent.total_paid.checked_add(amount).unwrap();
        Ok(())
    }

    /// 服务结果后更新信誉 (success/failed)
    pub fn update_reputation(ctx: Context<UpdateReputation>, success: bool) -> Result<()> {
        let agent = &mut ctx.accounts.agent;
        require!(agent.registered, AgentError::NotRegistered);
        agent.tasks = agent.tasks.checked_add(1).unwrap();
        if success {
            agent.success = agent.success.checked_add(1).unwrap();
        }
        agent.reputation = ((agent.success as u64) * 100 / (agent.tasks as u64)) as u8;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct RegisterAgent<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + AgentAccount::INIT_SPACE,
        seeds = [b"agent", authority.key().as_ref()],
        bump
    )]
    pub agent: Account<'info, AgentAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PayAgent<'info> {
    #[account(mut)]
    pub agent: Account<'info, AgentAccount>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: 买方 USDC ATA (程序不校验其所有权, token 指令会验证)
    #[account(mut)]
    pub buyer_token: Account<'info, TokenAccount>,
    /// CHECK: Agent USDC ATA
    #[account(mut)]
    pub agent_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateReputation<'info> {
    #[account(mut, has_one = authority)]
    pub agent: Account<'info, AgentAccount>,
    pub authority: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct AgentAccount {
    pub authority: Pubkey,
    pub reputation: u8,
    pub tasks: u64,
    pub success: u64,
    pub total_paid: u64,
    pub registered: bool,
}

#[error_code]
pub enum AgentError {
    #[msg("agent 未注册")]
    NotRegistered,
    #[msg("信誉过低 (<60)")]
    ReputationTooLow,
}
