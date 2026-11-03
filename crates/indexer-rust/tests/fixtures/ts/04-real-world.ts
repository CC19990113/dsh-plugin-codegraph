import { Injectable } from '@angular/core'
import type { Observable } from 'rxjs'

export interface User { id: number; name: string }

export type UserId = string

enum Role { Admin = 'admin', User = 'user' }

@Injectable({ providedIn: 'root' })
export class UserService {
  private static instance: UserService
  readonly baseUrl = '/api/users'
  #cache = new Map<string, User>()

  constructor(private readonly http: HttpClient) {}

  async fetchUser(id: UserId): Promise<User> {
    const cached = this.#cache.get(id)
    if (cached !== undefined) return cached
    const user = await this.http.get<User>(`${this.baseUrl}/${id}`)
    this.#cache.set(id, user)
    return user
  }

  static create(http: HttpClient): UserService {
    return new UserService(http)
  }
}

export function makeService(http: HttpClient): UserService {
  return UserService.create(http)
}

export default class AppModule {}
