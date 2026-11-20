# The owner can hand the project to a member

A project still has one owner. That person can give the role to someone who is already a member. TaskFlow does not transfer to an email that has not been added, and it does not send mail.

The previous owner is stored as a member before the project document changes owner. If that claim loses a race, the new member row is removed and the project stays with the original owner. The new owner's membership row is then closed, because the owner is not also a member. API keys are left in place. They belong to the project, and the new owner is the one who can revoke them.

The previous owner can leave after the transfer. Until then, they cannot.
