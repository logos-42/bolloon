//! 角色与能力门禁（纯函数）
//!
//! 警长（Sheriff）相较普通内部智能体拥有更多权限：完全访问 + 读写其他智能体的内部文档。
//! 这里只定义「谁能做什么」的判定；真正的资源访问（AgentDocs）在调用点经此门禁校验（fail-closed）。
//!
//! 对齐用户定：警长对其他内部智能体负有责任与义务，但具备更多权限 —— 包括完全访问权限，
//! 以及对其他智能体的内部文档也有访问和修改权限。

/// 能力
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Capability {
    /// 读写自己的内部文档（默认都有）
    OwnDocs,
    /// 读取任意智能体的内部文档
    ReadAnyAgentDoc,
    /// 修改任意智能体的内部文档
    WriteAnyAgentDoc,
    /// 完全文件系统访问
    FullFs,
}

/// 角色
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// 普通内部智能体 / 人类 / 外部顾问：只有自己的文档
    Member,
    /// 警长：对其他内部智能体负有责任与义务，并拥有越权访问
    Sheriff,
}

impl Role {
    /// 该角色拥有的能力集合
    pub fn capabilities(&self) -> Vec<Capability> {
        match self {
            Role::Member => vec![Capability::OwnDocs],
            Role::Sheriff => vec![
                Capability::OwnDocs,
                Capability::ReadAnyAgentDoc,
                Capability::WriteAnyAgentDoc,
                Capability::FullFs,
            ],
        }
    }

    /// 是否具备某能力（纯判定，fail-closed：未知角色 = 无越权）
    pub fn can(&self, cap: Capability) -> bool {
        self.capabilities().contains(&cap)
    }
}

/// 判断某角色能否对目标智能体的文档做某操作（纯函数）。
///
/// `target_is_self` 为 true 时任何角色都能读写自己；否则只有具备对应越权能力的角色才行。
/// fail-closed：默认拒绝越权，除非角色明确拥有该能力。
pub fn can_access_doc(role: Role, target_is_self: bool, write: bool) -> bool {
    if target_is_self {
        return true; // 自己的文档永远可访问
    }
    if write {
        role.can(Capability::WriteAnyAgentDoc)
    } else {
        role.can(Capability::ReadAnyAgentDoc)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn member_cannot_access_others_docs() {
        assert!(can_access_doc(Role::Member, true, true));
        assert!(!can_access_doc(Role::Member, false, false));
        assert!(!can_access_doc(Role::Member, false, true));
    }

    #[test]
    fn sheriff_can_access_others_docs() {
        assert!(can_access_doc(Role::Sheriff, false, false));
        assert!(can_access_doc(Role::Sheriff, false, true));
        assert!(Role::Sheriff.can(Capability::FullFs));
    }

    #[test]
    fn sheriff_capabilities_superset() {
        let s = Role::Sheriff.capabilities();
        assert!(s.contains(&Capability::ReadAnyAgentDoc));
        assert!(s.contains(&Capability::WriteAnyAgentDoc));
        assert!(s.contains(&Capability::FullFs));
    }
}
